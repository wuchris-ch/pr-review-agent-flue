export async function deliver(event, submit) {
  try {
    await submit(event.id, event.payload);
  } catch (error) {
    if (error.code !== 'ETIMEDOUT') throw error;
    await submit(event.id, event.payload);
  }
}
