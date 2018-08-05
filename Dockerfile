FROM node
WORKDIR /unifi2mqtt
COPY package*.json ./
RUN npm install

COPY . .

CMD node index.js
#pass arguments like docker run -e "insecure=true" -e "unifi-password=supersekrit" ...
