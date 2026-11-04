# officeace2api —— 容器镜像
#
# 项目零 npm 依赖，所以没有 `npm install` 这一步；镜像里只放运行期需要的文件。

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    OFFICEACE2API_HOST=0.0.0.0 \
    OFFICEACE2API_PORT=7864 \
    OFFICEACE2API_CONFIG=/app/data/config.json

WORKDIR /app

# su-exec 只用于入口脚本：以 root 修正挂载目录属主后降权到 node 跑服务。
RUN apk add --no-cache su-exec

# 只拷服务本体、清单和默认配置；data/ 与 logs/ 由卷提供。
COPY package.json ./
COPY src ./src
COPY config.example.json ./
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs

EXPOSE 7864

# /healthz 不需要鉴权，账号还没配好时也会回答（status: degraded）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OFFICEACE2API_PORT||7864)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.mjs"]
