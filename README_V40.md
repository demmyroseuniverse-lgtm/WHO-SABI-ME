# WHO SABI ME? v40

Full production deployment package for the WHO SABI ME? web app.

Run locally:

```bash
npm install
npm start
```

Production:

```bash
cp .env.production.example .env.production
# edit .env.production
./deploy.sh
```

Health:

```bash
curl http://127.0.0.1:8080/api/health
curl http://127.0.0.1:8080/api/ready
```

Backup:

```bash
./backup.sh
```

Do not commit `.env.production` or real API keys.
