#!/bin/sh
set -e
cd /opt/smart-finance

if [ ! -f .env.production ]; then
  echo "ERROR: .env.production not found. Run: bash scripts/gen-env-prod.sh"
  exit 1
fi

echo "=== Starting Smart Finance ==="
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d --build

echo ""
echo "=== Waiting for services ==="
sleep 30
docker compose ps
echo ""
curl -s http://localhost:3000/api/health
