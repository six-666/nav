// LICENSE GPL3.0 https://github.com/xjh22222228/nav/blob/main/LICENSE
// 未授权擅自使用自有部署软件（当前文件），一旦发现将追究法律责任，https://official.nav3.cn/pricing
// 开源项目，未经作者同意，不得以抄袭/复制代码/修改源代码版权信息。
// Copyright @ 2018-present xiejiahe. All rights reserved.
// See https://github.com/xjh22222228/nav

import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import bodyParser from 'body-parser'
import history from 'connect-history-api-fallback'
import compression from 'compression'
import nodemailer from 'nodemailer'
import dayjs from 'dayjs'
import getWebInfo from 'info-web'
import yaml from 'js-yaml'
import {
  getWebCount,
  setWebs,
  spiderWebs,
  writeSEO,
  writeTemplate,
  PATHS,
  fileWriteStream,
  fileReadStream,
} from '../../scripts/utils'
import type {
  ISettings,
  INavProps,
  IWebProps,
  ITagPropValues,
  ISearchProps,
  InternalProps,
  IComponentProps,
} from '../types/index'
import { SELF_SYMBOL } from '../constants/symbol'
import { HTTP_BASE_URL } from '../utils/http'
import axios from 'axios'
import sharp from 'sharp'
import findChrome from 'chrome-finder'
import { filterLoginData, removeTrailingSlashes } from '../utils/pureUtils'
import puppeteer from 'puppeteer'

const joinPath = (p: string): string => path.resolve(p)

const getConfig = () => yaml.load(fs.readFileSync(PATHS.config, 'utf8')) as any

const PORT = getConfig().port

const getSettings = () =>
  JSON.parse(fs.readFileSync(PATHS.settings, 'utf8')) as ISettings

const getTags = () =>
  JSON.parse(fs.readFileSync(PATHS.tag, 'utf8')) as ITagPropValues[]
const getCollects = (): IWebProps[] => {
  try {
    const data = JSON.parse(fs.readFileSync(PATHS.collect, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
const getComponent = (): IComponentProps => {
  try {
    return JSON.parse(
      fs.readFileSync(PATHS.component, 'utf8'),
    ) as IComponentProps
  } catch {
    return { zoom: 1, components: [] }
  }
}

const getWebs = async (req: Request, isFilter = true): Promise<any[]> => {
  const { isLogin } = req.body
  const data = await fileReadStream(PATHS.serverdb)
  const parseData = JSON.parse(data)
  if (!isFilter) {
    return parseData
  }
  return filterLoginData(JSON.parse(data), isLogin)
}

const writeWebs = async (data: any[]) => {
  return Promise.all([
    fileWriteStream(PATHS.db, data),
    fileWriteStream(PATHS.serverdb, data),
  ])
}

async function changePermissions() {
  const paths = [
    PATHS.db,
    PATHS.serverdb,
    PATHS.settings,
    PATHS.tag,
    PATHS.search,
    PATHS.html.index,
    PATHS.component,
    PATHS.upload,
  ]
  for (const path of paths) {
    try {
      const stats = await fsPromises.stat(path)
      if ((stats.mode & 0o777) !== 0o777) {
        await fsPromises.chmod(path, 0o777)
        console.log(`Permissions changed for ${path}`)
      } else {
        console.log(`${path} already has correct permissions`)
      }
    } catch (error: any) {
      console.error(`Error for ${path}: ${error.message}`)
    }
  }
}

changePermissions()

// Create user collect
try {
  fs.accessSync(PATHS.collect, fs.constants.F_OK)
} catch (error) {
  fs.writeFileSync(PATHS.collect, '[]')
  console.log((error as Error).message)
}

const app = express()
app.use(compression())
app.use(history())
app.use(bodyParser.json({ limit: '10000mb' }))
app.use(bodyParser.urlencoded({ limit: '10000mb', extended: true }))
app.use(
  cors({
    origin: '*',
    methods: '*',
    allowedHeaders: '*',
  }),
)
app.use(express.static('dist/browser'))
app.use(express.static('_upload'))

async function sendMail() {
  const mailConfig = getConfig().mailConfig
  const transporter = nodemailer.createTransport({
    ...mailConfig,
    message: undefined,
    title: undefined,
  })
  await transporter.sendMail({
    from: mailConfig.auth.user,
    to: getSettings().email || getConfig().email,
    subject: mailConfig.title || '',
    html: mailConfig.message || '',
  })
}

async function generateScreenshot(req: Request) {
  const params: any = {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }
  try {
    const { width, height, resizeWidth, resizeHeight } = req.body
    let url = req.body.url
    if (url[0] === SELF_SYMBOL) {
      url = url.slice(1)
    }
    new URL(url)

    try {
      const chromePath = findChrome()
      params.executablePath = chromePath
      console.log(`chromePath: ${chromePath}`)
    } catch (error) {
      console.log((error as Error).message)
    }
    const browser = await puppeteer.launch(params)
    const page = await browser.newPage()
    await page.setViewport({
      width: width || 1280,
      height: height || 720,
    })
    await page.goto(url, { waitUntil: 'networkidle2' })
    const screenshotBuffer = await page.screenshot()
    const resizedBase64 = await sharp(screenshotBuffer)
      .resize(resizeWidth || 400, resizeHeight || 200, { fit: 'cover' })
      .png()
      .toBuffer()
      .then((buffer: Buffer) => buffer.toString('base64'))
    return {
      image: resizedBase64,
    }
  } catch (error) {
    try {
      const resData = await axios.post(
        `${HTTP_BASE_URL}/api/screenshot`,
        req.body,
        {
          timeout: 0,
        },
      )
      return {
        ...resData.data,
      }
    } catch (error) {
      throw new Error(
        `${(error as Error).message}; executablePath: ${
          params.executablePath || puppeteer.executablePath() || ''
        }`,
      )
    }
  }
}

function verifyMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['authorization']
  if (token !== `token ${getConfig().password}`) {
    res.status(401).json({
      status: 401,
      message: 'Bad credentials',
    })
    return
  }
  next(false)
}

app.get(
  '/api/users/verify',
  verifyMiddleware,
  (req: Request, res: Response) => {
    res.json({})
  },
)

app.post(
  '/api/contents/update',
  verifyMiddleware,
  async (req: Request, res: Response) => {
    const { path } = req.body
    let { content } = req.body
    try {
      if (path.includes('settings.json')) {
        const isExistsindexHtml = fs.existsSync(PATHS.html.index)
        if (isExistsindexHtml) {
          const indexHtml = await fileReadStream(PATHS.html.index)
          const webs = await getWebs(req)
          const settings = JSON.parse(content)
          const seoTemplate = writeSEO(webs, { settings })
          const html = writeTemplate({
            html: indexHtml,
            settings,
            seoTemplate,
          })
          await fileWriteStream(PATHS.html.index, html)
        }
      } else if (path.includes('db.json')) {
        content = setWebs(JSON.parse(content), getSettings(), getTags())
        await writeWebs(content)
        res.json({
          status: true,
        })
        return
      }

      await fileWriteStream(joinPath(path), content)
      res.json({
        status: true,
      })
    } catch (error) {
      res.status(500).json({
        message: (error as Error).message,
      })
    }
  },
)

app.post(
  '/api/contents/create',
  verifyMiddleware,
  (req: Request, res: Response) => {
    const { path: filePath, content } = req.body
    try {
      try {
        fs.statSync(PATHS.upload)
      } catch (error) {
        fs.mkdirSync(PATHS.upload, { recursive: true })
      }

      const dataBuffer = Buffer.from(content, 'base64')
      const uploadPath = path.resolve(PATHS.upload, filePath)
      fs.writeFileSync(uploadPath, dataBuffer)
      const imagePath = `/images/${filePath}`
      const baseUrl = removeTrailingSlashes(getConfig().address)
      res.json({
        imagePath,
        fullImagePath: baseUrl + imagePath,
      })
    } catch (error) {
      res.status(500).json({
        message: (error as Error).message,
      })
    }
  },
)

interface Contents {
  settings: ISettings
  webs: INavProps[]
  tags: ITagPropValues[]
  search: ISearchProps[]
  internal: InternalProps
  component: IComponentProps
}

app.post('/api/contents/get', async (req: Request, res: Response) => {
  const { isLogin } = req.body
  const params: Contents = {
    webs: [],
    settings: {} as ISettings,
    tags: [],
    search: [],
    internal: {} as InternalProps,
    // @ts-ignore
    component: {},
  }
  try {
    params.webs = await getWebs(req, false)
    params.settings = getSettings()
    params.component = getComponent()
    params.tags = getTags()
    params.search = JSON.parse(fs.readFileSync(PATHS.search, 'utf8'))
    const { userViewCount, loginViewCount } = getWebCount(params.webs)
    params.internal.userViewCount = userViewCount
    params.internal.loginViewCount = loginViewCount
    params.webs = filterLoginData(
      setWebs(params.webs, params.settings, params.tags),
      isLogin,
    )
    res.json(params)
    return
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
  }
})

app.post('/api/spider', async (req: Request, res: Response) => {
  try {
    const webs = await getWebs(req)
    const settings = getSettings()
    res.setHeader('Transfer-Encoding', 'chunked')
    const {
      time,
      webs: w,
      errorUrlCount,
    } = await spiderWebs(webs, settings, {
      onOk: (messages) => {
        res.write(JSON.stringify(messages))
      },
    })
    settings.errorUrlCount = errorUrlCount
    await writeWebs(w)
    fs.writeFileSync(PATHS.settings, JSON.stringify(settings))
    res.write(JSON.stringify({ time }))
    res.end()
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
  }
})

app.post(
  '/api/collect/get',
  verifyMiddleware,
  async (req: Request, res: Response) => {
    try {
      const collects = getCollects()
      res.json({
        data: collects,
        count: collects.length,
      })
    } catch (error) {
      res.json({
        data: [],
        count: 0,
        message: (error as Error).message,
      })
    }
  },
)

app.post(
  '/api/collect/delete',
  verifyMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { data } = req.body
      const collects = getCollects().filter((e) => {
        const has = data.some(
          (item: IWebProps) => item['extra'].uuid === e['extra'].uuid,
        )
        return !has
      })
      fs.writeFileSync(PATHS.collect, JSON.stringify(collects))
      res.json({
        data: collects,
      })
    } catch (error) {
      res.json({
        data: [],
        message: (error as Error).message,
      })
    }
  },
)

app.post('/api/collect/save', async (req: Request, res: Response) => {
  try {
    const { data } = req.body
    data.extra.uuid = Date.now()
    data.createdAt = dayjs().format('YYYY-MM-DD HH:mm')
    const collects = getCollects()
    collects.unshift(data)
    fs.writeFileSync(PATHS.collect, JSON.stringify(collects))
    sendMail().catch((e) => {
      console.log(e.message)
    })
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
    return
  }
  res.json({
    message: 'OK',
  })
})

app.post('/api/web/info', async (req: Request, res: Response) => {
  try {
    let url = req.body.url
    if (url[0] === SELF_SYMBOL) {
      url = url.slice(1)
    }
    const data: any = await getWebInfo(url, {
      timeout: 0,
    })
    res.json({
      title: data.title,
      description: data.description,
      url: data.iconUrl,
      message: data.errorMsg,
    })
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
  }
})

app.post('/api/translate', async (req: Request, res: Response) => {
  const { content, language } = req.body

  try {
    const token = getConfig().XFAPIPassword
    if (!token) {
      const { data } = await axios.post(
        `${HTTP_BASE_URL}/api/translate`,
        req.body,
      )
      res.json(data)
      return
    }

    const { data } = await axios.post(
      'https://spark-api-open.xf-yun.com/v1/chat/completions',
      {
        model: 'lite',
        messages: [
          {
            role: 'user',
            content: `${content} 翻译${
              language === 'zh-CN' ? '中文' : '英文'
            }，直接返回翻译的内容，如果不能翻译返回原内容`,
          },
        ],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )

    res.json({
      content: data.choices[0].message.content,
    })
    return
  } catch (error: any) {
    res.status(500).json({
      message: error.message,
    })
  }
})

app.post('/api/screenshot', async (req: Request, res: Response) => {
  try {
    const imgData = await generateScreenshot(req)
    res.json({ ...imgData })
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
  }
})

app.post(
  '/api/config/get',
  verifyMiddleware,
  async (req: Request, res: Response) => {
    res.json({
      ...getConfig(),
    })
  },
)

app.post(
  '/api/config/update',
  verifyMiddleware,
  async (req: Request, res: Response) => {
    try {
      const isExistsindexHtml = fs.existsSync(PATHS.html.index)
      if (isExistsindexHtml) {
        const payload = {
          ...getConfig(),
          ...req.body,
        }
        const data = yaml.dump(payload)
        await fsPromises.writeFile(PATHS.config, data)
        let indexHtml = await fileReadStream(PATHS.html.index)

        const strs = `
  <script>
  window.__HASH_MODE__ = ${payload.hashMode};
  window.__ADDRESS__ = "${payload.address}";
  </script>      
  `.trim()
        indexHtml = indexHtml.replace(
          /(<!-- nav\.const-start -->)(.|\s)*?(<!-- nav.const-end -->)/i,
          `$1${strs}$3`,
        )
        await fileWriteStream(PATHS.html.index, indexHtml)
        res.json({
          status: true,
        })
        return
      }

      res.json({
        message: 'Please create index.html first',
        status: false,
      })
    } catch (error) {
      res.status(500).json({
        message: (error as Error).message,
      })
    }
  },
)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port :${PORT} \n`)
})
