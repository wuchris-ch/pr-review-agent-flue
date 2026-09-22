export async function loadBatch(ids, load) {
  const results = [];
  for (let offset = 0; offset < ids.length; offset += 20) {
    results.push(...await Promise.all(ids.slice(offset, offset + 20).map(load)));
  }
  return results;
}
