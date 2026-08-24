export async function withTimeout(promiseLike, ms, name) {
  let timer;

  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${name}`));
    }, ms);
  });
  const wrappedPromise = Promise.resolve(promiseLike);

  return Promise.race([
    wrappedPromise.finally(() => clearTimeout(timer)),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}
