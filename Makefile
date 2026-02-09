.PHONY: up down start stop restart logs ps build

build:
	docker compose build

up:
	docker compose up -d --build

down:
	docker compose down

start:
	docker compose start

stop:
	docker compose stop

restart:
	docker compose restart

logs:
	docker compose logs -f --tail=200

ps:
	docker compose ps

