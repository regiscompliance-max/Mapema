data "aws_availability_zones" "az" { state = "available" }

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  tags                 = { Name = "mapema-${var.env}" }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = data.aws_availability_zones.az.names[count.index]
  tags              = { Name = "mapema-${var.env}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.az.names[count.index]
  tags              = { Name = "mapema-${var.env}-private-${count.index}" }
}

resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.main.id }
resource "aws_eip" "nat" { domain = "vpc" }
resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
}
# route tables, VPC flow logs (to CloudWatch, 90 days) and an egress proxy allow-list for ERP hosts (S-13) go here
