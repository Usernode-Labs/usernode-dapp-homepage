# dapp-homepage

Minimal Node server that serves `index.html` and `dapps.json`.

## Run with Docker (recommended)

- **Start (build + run in background)**:

```bash
docker compose up -d --build
```

- **View logs**:

```bash
docker compose logs -f --tail=200
```

- **Stop**:

```bash
docker compose stop
```

- **Start again (no rebuild)**:

```bash
docker compose start
```

- **Restart**:

```bash
docker compose restart
```

- **Remove container/network**:

```bash
docker compose down
```

Then open:
- `http://localhost:8000`
- `http://localhost:8000/dapps.json`

### Change the port

By default it listens on port 8000. To change it, update `docker-compose.yml`:
- `environment.PORT`
- `ports` mapping

## Run locally (no Docker)

Requires Node.js.

```bash
node server.js
```

## Makefile shortcuts

If you have GNU Make installed:

```bash
make up
make logs
make stop
make start
make restart
make down
```
