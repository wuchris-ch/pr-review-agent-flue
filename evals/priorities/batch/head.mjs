export async function loadBatch(ids, load) {
  return Promise.all(ids.map(load));
}
