FROM node:22-slim
WORKDIR /app
# Copy the workspace manifests first for cacheable installs.
COPY package.json package-lock.json ./
COPY packages/keyboards-mcp/package.json packages/keyboards-mcp/package.json
COPY packages/sounds-and-recreation-app/package.json packages/sounds-and-recreation-app/package.json
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
RUN npm run build -w keyboards-mcp
