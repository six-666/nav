// LICENSE GPL3.0 https://github.com/xjh22222228/nav/blob/main/LICENSE
// 未授权擅自使用自有部署软件（当前文件），一旦发现将追究法律责任，https://official.nav3.cn/pricing
// 开源项目，未经作者同意，不得以抄袭/复制代码/修改源代码版权信息。
// Copyright @ 2018-present xiejiahe. All rights reserved.
// See https://github.com/xjh22222228/nav

import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
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
  spiderWeb,
  writeSEO,
  writeTemplate,
  PATHS,
} from '../../scripts/util.mjs'

const joinPath = (p) => path.resolve(p)

const getConfigJson = () => yaml.load(fs.readFileSync(PATHS.config))
const PORT = getConfigJson().port

const getSettings = () => JSON.parse(fs.readFileSync(PATHS.settings).toString())
const getCollects = () => {
  try {
    const data = JSON.parse(fs.readFileSync(PATHS.collect).toString())
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
const getComponents = () => {
  try {
    return JSON.parse(fs.readFileSync(PATHS.component).toString())
  } catch {
    return []
  }
}

try {
  ;[
    PATHS.db,
    PATHS.settings,
    PATHS.tag,
    PATHS.search,
    PATHS.html.index,
    PATHS.component,
  ].forEach((path) => {
    fs.chmodSync(path, 0o777)
  })
} catch (error) {
  console.log(error.message)
}

// Create user collect
try {
  fs.accessSync(PATHS.collect, fs.constants.F_OK)
} catch (error) {
  fs.writeFileSync(PATHS.collect, '[]')
  console.log(error.message)
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
  })
)
app.use(express.static('dist/browser'))
app.use(express.static('_upload'))

async function sendMail() {
  const mailConfig = getConfigJson().mailConfig
  const transporter = nodemailer.createTransport({
    ...mailConfig,
    message: undefined,
    title: undefined,
  })
  await transporter.sendMail({
    from: mailConfig.auth.user,
    to: getSettings().email || getConfigJson().email,
    subject: mailConfig.title || '',
    html: mailConfig.message || '',
  })
}

function verifyMiddleware(req, res, next) {
  const token = req.headers['authorization']
  if (token !== `token ${getConfigJson().password}`) {
    return res.status(401).json({
      status: 401,
      message: 'Bad credentials',
    })
  }
  next(false)
}

app.get('/api/users/verify', verifyMiddleware, (req, res) => {
  res.json({})
})

app.post('/api/contents/update', verifyMiddleware, (req, res) => {
  const { path, content } = req.body
  try {
    fs.writeFileSync(joinPath(path), content)

    if (path.includes('settings.json')) {
      const isExistsindexHtml = fs.existsSync(PATHS.html.index)
      if (isExistsindexHtml) {
        const indexHtml = fs.readFileSync(PATHS.html.index).toString()
        const webs = JSON.parse(fs.readFileSync(PATHS.db).toString())
        const settings = getSettings()
        const seoTemplate = writeSEO(webs, { settings })
        const html = writeTemplate({
          html: indexHtml,
          settings,
          seoTemplate,
        })
        fs.writeFileSync(PATHS.html.index, html)
      }
    }

    res.json({})
  } catch (error) {
    res.status(500).json({
      message: error.message,
    })
  }
})

app.post('/api/contents/create', verifyMiddleware, (req, res) => {
  const { path: filePath, content } = req.body
  try {
    try {
      fs.statSync(PATHS.upload)
    } catch (error) {
      fs.mkdirSync(PATHS.upload, { recursive: true })
    }

    const dataBuffer = Buffer.from(content, 'base64')
    const uploadPath = path.join(PATHS.upload, filePath)
    fs.writeFileSync(uploadPath, dataBuffer)
    res.json({
      imagePath: path.join('/', 'images', filePath),
    })
  } catch (error) {
    res.status(500).json({
      message: error.message,
    })
  }
})

app.post('/api/contents/get', (req, res) => {
  const params = {
    webs: [],
    settings: {},
    tags: [],
    search: [],
    internal: {},
    components: [],
  }
  try {
    params.webs = JSON.parse(fs.readFileSync(PATHS.db).toString())
    params.settings = getSettings()
    params.components = getComponents()
    params.tags = JSON.parse(fs.readFileSync(PATHS.tag).toString())
    params.search = JSON.parse(fs.readFileSync(PATHS.search).toString())
    const { userViewCount, loginViewCount } = getWebCount(params.webs)
    params.internal.userViewCount = userViewCount
    params.internal.loginViewCount = loginViewCount
    params.webs = setWebs(params.webs, params.settings, params.tags)
    return res.json(params)
  } catch (error) {
    res.status(500).json({
      message: error.message,
    })
  }
})

app.post('/api/spider', async (req, res) => {
  try {
    const webs = JSON.parse(fs.readFileSync(PATHS.db).toString())
    const settings = getSettings()
    const { time, webs: w, errorUrlCount } = await spiderWeb(webs, settings)
    settings.errorUrlCount = errorUrlCount
    fs.writeFileSync(PATHS.db, JSON.stringify(w))
    fs.writeFileSync(PATHS.settings, JSON.stringify(settings))
    return res.json({
      time,
    })
  } catch (error) {
    res.status(500).json({
      message: error.message,
    })
  }
})

app.post('/api/collect/get', async (req, res) => {
  try {
    const collects = getCollects()
    res.json({
      data: collects,
      count: collects.length,
    })
  } catch (error) {
    return res.json({
      data: [],
      count: 0,
      message: error.message,
    })
  }
})

app.post('/api/collect/delete', async (req, res) => {
  try {
    const { data } = req.body
    const collects = getCollects().filter((e) => {
      const has = data.some((item) => item.extra.uuid === e.extra.uuid)
      return !has
    })
    fs.writeFileSync(PATHS.collect, JSON.stringify(collects))
    res.json({
      data: collects,
    })
  } catch (error) {
    return res.json({
      data: [],
      message: error.message,
    })
  }
})

app.post('/api/collect/save', async (req, res) => {
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
    return res.status(500).json({
      message: error.message,
    })
  }
  res.json({
    message: 'OK',
  })
})

app.post('/api/web/info', async (req, res) => {
  try {
    let url = req.body.url
    if (url[0] === '!') {
      url = url.slice(1)
    }
    const data = await getWebInfo(url, {
      timeout: 0,
    })
    res.json({
      title: data.title,
      description: data.description,
      url: data.iconUrl,
      message: data.errorMsg,
    })
  } catch (error) {
    return res.status(500).json({
      message: error.message,
    })
  }
})

app.listen(PORT, () => {
  console.log(`Server is running on port :${PORT}`)
})
