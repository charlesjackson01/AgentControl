import { buildApp } from './app.js'

const app = buildApp()
const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1'

app
  .listen({ port, host })
  .then(() => app.log.info(`AgentControl API listening on http://${host}:${port}`))
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
