# ═══════════════════════════════════════════════════════════════
# PURSUIT ZONE — AWS Infrastructure (Terraform)
# EKS + RDS PostGIS + ElastiCache Redis + ALB + S3
# ═══════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.40" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.27" }
    helm = { source = "hashicorp/helm", version = "~> 2.12" }
  }
  backend "s3" {
    bucket         = "pursuitzone-terraform-state"
    key            = "infra/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "pursuitzone-terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "PursuitZone"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

variable "aws_region"   { default = "us-east-1" }
variable "environment"  { default = "production" }
variable "db_password"  { sensitive = true }

locals {
  name = "pursuitzone-${var.environment}"
}

# ── VPC ──────────────────────────────────────────
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.5.1"

  name = "${local.name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = var.environment != "production"
  enable_dns_hostnames = true
  enable_dns_support   = true

  public_subnet_tags = {
    "kubernetes.io/role/elb" = 1
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = 1
  }
}

# ── EKS CLUSTER ──────────────────────────────────
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "20.8.0"

  cluster_name    = "${local.name}-eks"
  cluster_version = "1.29"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access = true

  eks_managed_node_groups = {
    # API servers — handles REST + WebSocket
    api = {
      name           = "api-nodes"
      instance_types = ["c6i.xlarge"]   # 4 vCPU, 8GB — compute optimized
      min_size       = 2
      max_size       = 20
      desired_size   = 3

      labels = { workload = "api" }
    }

    # GPS processing — high throughput location data
    gps = {
      name           = "gps-nodes"
      instance_types = ["c6i.2xlarge"]  # 8 vCPU, 16GB
      min_size       = 1
      max_size       = 10
      desired_size   = 2

      labels = { workload = "gps-processor" }
    }

    # Background jobs — matchmaking, geofence, zone shrink
    workers = {
      name           = "worker-nodes"
      instance_types = ["m6i.large"]    # 2 vCPU, 8GB — general purpose
      min_size       = 1
      max_size       = 5
      desired_size   = 2

      labels = { workload = "worker" }
    }
  }

  # Enable IRSA for service accounts
  enable_irsa = true
}

# ── RDS PostgreSQL + PostGIS ─────────────────────
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "6.4.0"

  identifier = "${local.name}-db"

  engine               = "postgres"
  engine_version       = "15.5"
  family               = "postgres15"
  major_engine_version = "15"
  instance_class       = "db.r6g.xlarge"  # 4 vCPU, 32GB RAM — memory optimized

  allocated_storage     = 100
  max_allocated_storage = 500
  storage_encrypted     = true

  db_name  = "pursuitzone"
  username = "pursuit"
  password = var.db_password
  port     = 5432

  multi_az               = var.environment == "production"
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period = 7
  deletion_protection     = var.environment == "production"

  # Enable PostGIS
  parameters = [
    { name = "shared_preload_libraries", value = "pg_stat_statements" },
    { name = "max_connections", value = "500" },
    { name = "work_mem", value = "256MB" },
    { name = "maintenance_work_mem", value = "512MB" },
    { name = "effective_cache_size", value = "24GB" },
    { name = "random_page_cost", value = "1.1" },   # SSD optimized
  ]

  # Read replica for heavy GPS queries
  create_db_instance_read_replica = var.environment == "production"
}

resource "aws_security_group" "rds" {
  name_prefix = "${local.name}-rds-"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }
}

# ── ElastiCache Redis Cluster ────────────────────
# Redis is critical for: Socket.io adapter, chase state, geofence cache,
# matchmaking state, position cache, pub/sub for real-time events
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name}-redis"
  description          = "PursuitZone Redis cluster"

  node_type            = "cache.r6g.large"    # 2 vCPU, 13GB
  num_cache_clusters   = var.environment == "production" ? 3 : 1
  
  engine               = "redis"
  engine_version       = "7.1"
  port                 = 6379
  parameter_group_name = "default.redis7"

  automatic_failover_enabled = var.environment == "production"
  multi_az_enabled          = var.environment == "production"

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit = 3
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis-subnet"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name_prefix = "${local.name}-redis-"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }
}

# ── S3 for GPS data archival ─────────────────────
resource "aws_s3_bucket" "gps_archive" {
  bucket = "${local.name}-gps-archive"
}

resource "aws_s3_bucket_lifecycle_configuration" "gps_archive" {
  bucket = aws_s3_bucket.gps_archive.id

  rule {
    id     = "archive-old-gps"
    status = "Enabled"
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    transition {
      days          = 90
      storage_class = "DEEP_ARCHIVE"
    }
    expiration {
      days = 365
    }
  }
}

# ── Outputs ──────────────────────────────────────
output "eks_cluster_name"    { value = module.eks.cluster_name }
output "eks_cluster_endpoint" { value = module.eks.cluster_endpoint }
output "rds_endpoint"         { value = module.rds.db_instance_endpoint }
output "redis_endpoint"       { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "vpc_id"              { value = module.vpc.vpc_id }
