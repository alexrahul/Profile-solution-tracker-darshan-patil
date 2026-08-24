import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";

const [, , email, password, name="Admin"] = process.argv;
if(!email || !password){console.error('Usage: npm run create-admin -- admin@example.com YourPassword "Admin Name"');process.exit(1)}
try{
  const hash=await bcrypt.hash(password,12);
  const r=await pool.query(`insert into users(name,email,password_hash,role,active) values($1,$2,$3,'ADMIN',true)
    on conflict(email) do update set name=excluded.name,password_hash=excluded.password_hash,role='ADMIN',active=true
    returning id,name,email,role`,[name,email,hash]);
  console.log("Admin ready:",r.rows[0]);
}finally{await pool.end()}
