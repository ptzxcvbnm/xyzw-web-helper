import { db } from '../lib/db.js';

const password = process.env.ADMIN_PASSWORD;

if (!password || password.length < 6) {
  console.error('ADMIN_PASSWORD must be at least 6 characters');
  process.exit(1);
}

const admin = db.getUser('admin');
if (admin) {
  db.updateUserPassword('admin', password);
  console.log('admin password updated');
} else {
  db.createUser('admin', password);
  console.log('admin user created');
}
