export async function deliver(event, submit) {
  await submit(event.id, event.payload);
}
