/** Look up users by the email supplied in an HTTP request. */
export function findUsersByEmail(database, email) {
  return database.prepare('SELECT id, email FROM users WHERE email = ?').all(email);
}
