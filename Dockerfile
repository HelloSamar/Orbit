FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# sharp is an optional image-processing dependency. Installing it under emulated
# ARM64 (QEMU) can crash during native postinstall, so we skip lifecycle scripts in
# the production image and let the app gracefully fall back to the original image
# when sharp is unavailable.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
RUN mkdir -p shared certs && chown -R node:node shared certs
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/static/login.css').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
