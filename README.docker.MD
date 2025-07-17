npm run build:web

docker build -t splayer . --no-cache

docker run -d -p 3889:25884 -p 3887:3000 -p 3886:8081 -p 3890:25885  --name website splayer