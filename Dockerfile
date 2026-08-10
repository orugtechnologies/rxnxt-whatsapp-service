FROM node:18-alpine
RUN apk add --no-cache git
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3001
CMD [ "node", "server.js" ]
