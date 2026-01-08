// Legacy Prisma seed file. Intentionally left as a no-op because
// admin users (CEO/Manager) are now created through a secure
// one-time setup flow instead of environment variables.

async function main() {
  // No-op
}

main().catch((err) => {
  console.error('[seed] Unexpected error:', err?.message || err);
  process.exitCode = 1;
});
