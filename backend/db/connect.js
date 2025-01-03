// connect.js
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config({ path: '/home/ec2-user/Stock-Sync-Logic/backend/.env' }); // Adjust the path as needed

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: false, // SSL disabled due to server not supporting SSL connections // Enabling SSL for production, while allowing insecure in development
});

// Test the connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error acquiring client', err.stack);
  } else {
    console.log('PostgreSQL database connected successfully.');
    release();
  }
});

// Function to initialize the database (if required)
export async function initializeDatabase() {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS stores (
        shop_id VARCHAR(255) PRIMARY KEY,
        shop_domain VARCHAR(255) UNIQUE NOT NULL,
        access_token VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )`
    );
    console.log('Database initialized and tables created if they did not exist.');

    // Additional check for table existence
    const result = await pool.query("SELECT to_regclass('public.stores') AS table_exists");
    if (result.rows[0].table_exists) {
      console.log('Stores table already exists.');
    } else {
      console.log('Stores table created successfully.');
    }
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

// Function to retrieve the access token for a shop
export async function getAccessToken(shopDomain) {
  try {
    const result = await pool.query('SELECT access_token FROM stores WHERE shop_domain = $1', [shopDomain]);
    if (result.rows.length === 0) {
      throw new Error(`No access token found for shop: ${shopDomain}`);
    }
    console.log(`Access token retrieved successfully for shop: ${shopDomain}`);
    return result.rows[0].access_token;
  } catch (error) {
    console.error('Error retrieving access token:', error);
    throw error;
  }
}

export { pool }; // Export pool for use elsewhere
