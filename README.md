# Example project using dogsvr
This project implemented game servers using dogsvr, including three types of servers:
- dir: Query the list of zones
- zonesvr: Player login and main logic
- battlesvr: Battle related logic

And for visual display, a web game client has been implemented.

# How to run server
## prepare environment (If already installed, it can be ignored)
- nodejs
- typescript
- pm2
- redis service
- mongodb service

If redis/mongo service is not available, Docker can be chosen to run locally accessible services:
```sh
docker run --name dog-mongodb --network host -d mongodb/mongodb-community-server --bind_ip localhost
docker run --name dog-redis --network host -d redis redis-server --bind 127.0.0.1
```

## build and start servers
```sh
git clone https://github.com/dogsvr/example-proj.git
cd example-proj
npm install
npm run build
npm run start
```

If lucky enough, typing "pm2 ls" command can see 3 processes running.
If problems, typing "pm2 logs" to check server logs.

# How to run client
```sh
git clone https://github.com/dogsvr/example-proj-client.git
cd example-proj-client
npm install
npm run start
```

Then follow the prompts to open browser and login this web game.
