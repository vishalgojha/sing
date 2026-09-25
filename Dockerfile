FROM python:3.12-slim

WORKDIR /app
COPY . /app

ENV PORT=8123
EXPOSE 8123

CMD ["sh", "-c", "python3 server.py ${PORT}"]
