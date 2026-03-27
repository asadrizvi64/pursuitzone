#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# PURSUIT ZONE — Full Infrastructure Deployment Script
# Sets up AWS EKS + RDS + ElastiCache + deploys app
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Pre-flight checks ────────────────────────
log "Running pre-flight checks..."

command -v terraform >/dev/null 2>&1 || err "terraform not found"
command -v kubectl >/dev/null 2>&1 || err "kubectl not found"
command -v aws >/dev/null 2>&1 || err "aws CLI not found"
command -v docker >/dev/null 2>&1 || err "docker not found"
command -v helm >/dev/null 2>&1 || err "helm not found"

[ -f ".env.production" ] || err ".env.production file not found. Copy from .env.example and fill in values."

source .env.production

log "Pre-flight checks passed ✓"

# ── Step 1: Terraform — Provision AWS infrastructure ──
log "Step 1/7: Provisioning AWS infrastructure with Terraform..."

cd infra/terraform
terraform init
terraform plan -var="db_password=${DB_PASSWORD}" -out=tfplan
terraform apply tfplan

# Extract outputs
EKS_CLUSTER=$(terraform output -raw eks_cluster_name)
RDS_ENDPOINT=$(terraform output -raw rds_endpoint)
REDIS_ENDPOINT=$(terraform output -raw redis_endpoint)

cd ../..
log "AWS infrastructure provisioned ✓"

# ── Step 2: Configure kubectl ────────────────
log "Step 2/7: Configuring kubectl for EKS..."

aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "${AWS_REGION:-us-east-1}"
kubectl cluster-info
kubectl create namespace pursuitzone --dry-run=client -o yaml | kubectl apply -f -

log "kubectl configured ✓"

# ── Step 3: Create Kubernetes secrets ────────
log "Step 3/7: Creating Kubernetes secrets..."

kubectl create secret generic pursuitzone-secrets \
  --namespace=pursuitzone \
  --from-literal=database-url="postgres://pursuit:${DB_PASSWORD}@${RDS_ENDPOINT}:5432/pursuitzone" \
  --from-literal=database-read-url="postgres://pursuit:${DB_PASSWORD}@${RDS_ENDPOINT}:5432/pursuitzone" \
  --from-literal=redis-url="rediss://${REDIS_ENDPOINT}:6379" \
  --from-literal=jwt-secret="${JWT_SECRET}" \
  --from-literal=firebase-sa="${FIREBASE_SERVICE_ACCOUNT}" \
  --from-literal=stripe-key="${STRIPE_SECRET_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -

log "Secrets created ✓"

# ── Step 4: Initialize database ──────────────
log "Step 4/7: Initializing PostgreSQL + PostGIS..."

# Enable PostGIS extension
PGPASSWORD="${DB_PASSWORD}" psql -h "${RDS_ENDPOINT}" -U pursuit -d pursuitzone -c "CREATE EXTENSION IF NOT EXISTS postgis;" 2>/dev/null || true
PGPASSWORD="${DB_PASSWORD}" psql -h "${RDS_ENDPOINT}" -U pursuit -d pursuitzone -c "CREATE EXTENSION IF NOT EXISTS uuid-ossp;" 2>/dev/null || true

# Run schema
PGPASSWORD="${DB_PASSWORD}" psql -h "${RDS_ENDPOINT}" -U pursuit -d pursuitzone -f backend/src/models/schema.sql
PGPASSWORD="${DB_PASSWORD}" psql -h "${RDS_ENDPOINT}" -U pursuit -d pursuitzone -f backend/src/models/migrations.sql
PGPASSWORD="${DB_PASSWORD}" psql -h "${RDS_ENDPOINT}" -U pursuit -d pursuitzone -f infra/k8s/base/db-optimization.sql

log "Database initialized ✓"

# ── Step 5: Build and push Docker image ──────
log "Step 5/7: Building and pushing Docker image..."

IMAGE_TAG="ghcr.io/pursuitzone/api:$(git rev-parse --short HEAD)"

docker build -f backend/Dockerfile.production -t "$IMAGE_TAG" backend/
docker push "$IMAGE_TAG"

log "Docker image pushed: $IMAGE_TAG ✓"

# ── Step 6: Install monitoring stack ─────────
log "Step 6/7: Installing monitoring stack..."

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace=monitoring \
  --create-namespace \
  --set grafana.adminPassword="${GRAFANA_PASSWORD:-admin}" \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false

# Deploy PgBouncer, Redis/Postgres exporters
kubectl apply -f infra/k8s/base/monitoring.yaml -n pursuitzone

log "Monitoring stack installed ✓"

# ── Step 7: Deploy application ───────────────
log "Step 7/7: Deploying PursuitZone application..."

# Update image tag in deployment
sed -i "s|ghcr.io/pursuitzone/api:latest|${IMAGE_TAG}|g" infra/k8s/base/deployment.yaml

# Apply all K8s manifests
kubectl apply -f infra/k8s/base/deployment.yaml -n pursuitzone

# Wait for rollout
kubectl rollout status deployment/api -n pursuitzone --timeout=300s
kubectl rollout status deployment/worker -n pursuitzone --timeout=300s

# Get load balancer URL
sleep 30  # Wait for ALB provisioning
LB_URL=$(kubectl get ingress api-ingress -n pursuitzone -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "pending")

log "Application deployed ✓"

# ── Summary ──────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo " 🏎️  PURSUIT ZONE — Deployment Complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo " API Endpoint:  https://${LB_URL}"
echo " EKS Cluster:   ${EKS_CLUSTER}"
echo " Database:      ${RDS_ENDPOINT}"
echo " Redis:         ${REDIS_ENDPOINT}"
echo ""
echo " Monitoring:"
echo "   Grafana:     kubectl port-forward svc/monitoring-grafana 3000:80 -n monitoring"
echo "   Prometheus:  kubectl port-forward svc/monitoring-prometheus 9090:9090 -n monitoring"
echo ""
echo " Scaling:"
echo "   API pods:    kubectl scale deployment/api --replicas=N -n pursuitzone"
echo "   HPA active:  kubectl get hpa -n pursuitzone"
echo ""
echo " Next steps:"
echo "   1. Point DNS api.pursuitzone.io → ${LB_URL}"
echo "   2. Configure SSL certificate ARN in ingress"
echo "   3. Run load test: cd backend && npm run loadtest"
echo "   4. Set up EAS for mobile builds: cd mobile && eas build"
echo ""
