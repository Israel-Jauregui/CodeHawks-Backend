terraform {
  # Runtime values are supplied by the protected GitHub workflow. Keeping the
  # bucket out of Git makes the AWS account and state target explicit per run.
  backend "s3" {}
}
