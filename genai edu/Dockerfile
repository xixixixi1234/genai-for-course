FROM node:20-alpine

WORKDIR /app

# Required to compile better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
