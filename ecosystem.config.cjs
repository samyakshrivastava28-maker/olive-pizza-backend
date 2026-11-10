/**
 * Olive Pizza Canonical Backend — PM2 Production Process Configuration
 * Designed for bare-metal Linux VPS deployment (Ubuntu/Debian/Rocky)
 */
module.exports = {
  apps: [
    {
      name: 'olive-pizza-backend',
      script: 'server.ts',
      interpreter: './node_modules/.bin/tsx',
      instances: 'max', // Scale to available CPU cores or set to 1 for lightweight VPS
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 5000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
