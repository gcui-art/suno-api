# syntax=docker/dockerfile:1 
                                                                                                                                                                                                    
FROM node:lts-bookworm AS builder                                                                                       
WORKDIR /src                                                                                                            
COPY package*.json ./                                                                                                   
RUN npm install                                                                                                         
COPY . .                                                                                                               
RUN npm run build                                                                                                       
                                                                                                                    
FROM node:lts-bookworm                                                                                                  
WORKDIR /app                                                                                                            
COPY package*.json ./                                                                                                   
                                                                                                                    
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y libnss3 \
    libdbus-1-3
                                                                                                                    
ARG SUNO_COOKIE             
RUN if [ -z "$SUNO_COOKIE" ]; then echo "Warning: SUNO_COOKIE is not set. You will have to set the cookies in the Cookie header of your requests."; fi                                           
ENV SUNO_COOKIE=${SUNO_COOKIE}

RUN npm install --only=production
RUN npx playwright install --with-deps chromium
                                                                                                                    
COPY --from=builder /src/.next ./.next                                                                                  
EXPOSE 3000                                                                                                             
CMD ["npm", "run", "start"]
