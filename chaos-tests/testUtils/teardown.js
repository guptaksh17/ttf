/**
 * Shared utility for safely and thoroughly closing database pools, redis clients,
 * HTTP servers, and child processes in parallel.
 * Each cleanup call is isolated in a try/catch so failure in one does not block others.
 */
export async function closeAll({ server, pool, redis, publisherRedis, children } = {}) {
  const promises = [];

  // Close HTTP Server
  if (server) {
    promises.push(
      new Promise((resolve) => {
        try {
          server.close((err) => {
            if (err) console.error('Error closing HTTP server:', err);
            resolve();
          });
        } catch (err) {
          console.error('Failed calling server.close:', err);
          resolve();
        }
      })
    );
  }

  // End PostgreSQL Pool
  if (pool) {
    promises.push(
      (async () => {
        try {
          if (!pool.ending) {
            await pool.end();
          }
        } catch (err) {
          if (!err.message.includes('Called end on pool more than once')) {
            console.error('Error ending database pool:', err);
          }
        }
      })()
    );
  }

  // Quit primary Redis client
  if (redis) {
    promises.push(
      redis.quit().catch((err) => {
        console.error('Error quitting Redis client:', err);
      })
    );
  }

  // Quit implicit event publisher Redis client (often imported from eventPublisher.js)
  if (publisherRedis) {
    promises.push(
      publisherRedis.quit().catch((err) => {
        console.error('Error quitting publisher Redis client:', err);
      })
    );
  }

  // Terminate child processes
  if (children && Array.isArray(children)) {
    children.forEach((child, idx) => {
      if (!child) return;
      promises.push(
        new Promise((resolve) => {
          const name = `ChildProcess-${idx}`;
          const timer = setTimeout(() => {
            try {
              console.log(`Force killing ${name} (SIGKILL)...`);
              child.kill('SIGKILL');
            } catch (e) {}
            resolve();
          }, 3000);

          child.once('exit', (code) => {
            clearTimeout(timer);
            resolve();
          });

          try {
            child.kill('SIGTERM');
          } catch (e) {
            clearTimeout(timer);
            resolve();
          }
        })
      );
    });
  }

  await Promise.all(promises);
  console.log('[Teardown] All resources closed cleanly.');
}
