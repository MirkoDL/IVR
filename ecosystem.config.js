module.exports = {
    apps: [
      {
        name: 'IVR_server',
        script: 'server.js',
        watch: true,
        instances: 1,
        autorestart: true,
        restart_delay: 0
      },
    ],
  };
  