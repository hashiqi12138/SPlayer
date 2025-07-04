# 使用轻量级 Nginx 镜像作为基础
FROM nginx:1.25-alpine

# 安装所有依赖
RUN apk add --no-cache \
    npm \
    python3 \
    youtube-dl \
    dos2unix \
    gettext \
    && npm install -g \
    @unblockneteasemusic/server \
    NeteaseCloudMusicApi \
    && wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# 设置环境变量
ENV NODE_TLS_REJECT_UNAUTHORIZED=0 \
    NETEASE_API_PORT=3000 \
    UNBLOCK_PORT=80 \
    UNBLOCK_INTERNAL_PORT=443 \
    NETEASE_SERVER_IP="220.197.30.65" \
    UNBLOCK_SOURCES="kugou kuwo bilibili"

# 创建并配置启动脚本
RUN echo $'#!/bin/sh\n\
set -e\n\
echo "Container starting at $(date)"\n\
\n\
# 应用系统参数\n\
sysctl -p\n\
\n\
# 启动 unblockneteasemusic 服务\n\
echo "Starting unblockneteasemusic on port $UNBLOCK_PORT (internal: $UNBLOCK_INTERNAL_PORT)"\n\
npx unblockneteasemusic -p ${UNBLOCK_PORT}:${UNBLOCK_INTERNAL_PORT} -s -f ${NETEASE_SERVER_IP} -o ${UNBLOCK_SOURCES} > /var/log/unblock.log 2>&1 &\n\
\n\
# 更新 hosts 文件\n\
echo "Updating /etc/hosts for music.163.com domains"\n\
{\n\
    echo "127.0.0.1 music.163.com";\n\
    echo "127.0.0.1 interface.music.163.com";\n\
    echo "127.0.0.1 interface3.music.163.com";\n\
    echo "127.0.0.1 interface.music.163.com.163jiasu.com";\n\
    echo "127.0.0.1 interface3.music.163.com.163jiasu.com";\n\
} | tee -a /etc/hosts\n\
\n\
# 启动 NeteaseCloudMusicApi\n\
echo "Starting NeteaseCloudMusicApi on port $NETEASE_API_PORT"\n\
npx NeteaseCloudMusicApi --port $NETEASE_API_PORT > /var/log/api.log 2>&1 &\n\
\n\
# 启动 Nginx（前台运行）\n\
echo "Starting Nginx on port 25884"\n\
exec nginx -g "daemon off;"\n' > /start.sh \
    && chmod +x /start.sh \
    && dos2unix /start.sh

# 删除默认的 Nginx 欢迎页面
RUN rm -rf /usr/share/nginx/html/*

# 复制编译好的静态文件到 Nginx 服务目录
COPY out/renderer/ /usr/share/nginx/html

# 复制优化后的 Nginx 配置文件
COPY nginx.conf /etc/nginx/nginx.conf

# 创建健康检查文件
RUN echo "OK" > /usr/share/nginx/html/healthz

# 设置权限
RUN chown -R nginx:nginx /usr/share/nginx/html \
    && mkdir -p /var/log/nginx \
    && chown -R nginx:nginx /var/log/nginx

# 暴露所有需要的端口
EXPOSE $PORT $NETEASE_API_PORT $UNBLOCK_PORT $UNBLOCK_INTERNAL_PORT

# 启动命令
CMD ["/start.sh"]