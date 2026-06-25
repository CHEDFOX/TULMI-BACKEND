# Tulmi backend — production image for the VPS.
FROM node:20-slim AS build
WORKDIR /app
COPY tulmi/package.json tulmi/package-lock.json* ./tulmi/
WORKDIR /app/tulmi
RUN npm install --no-audit --no-fund
# Source (tulmi + shared types/prompts it imports across the repo root)
COPY tulmi/ /app/tulmi/
COPY shared/ /app/shared/
RUN npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
# Tell the app exactly where the shared/ dir (prompts) lives — robust regardless
# of the compiled directory layout.
ENV TULMI_SHARED_DIR=/app/shared
WORKDIR /app/tulmi
COPY --from=build /app/tulmi/package.json ./
COPY --from=build /app/tulmi/node_modules ./node_modules
COPY --from=build /app/tulmi/dist ./dist
# Prompts (.md) are read at runtime and are not emitted by tsc.
COPY --from=build /app/shared /app/shared
EXPOSE 8080
CMD ["node", "dist/tulmi/src/server.js"]
