require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 5001;

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

app.use(express.json());
app.use(cors());

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const jwtSecret = process.env.JWT_SECRET;

const authMiddleware = (req, res, next) => {
  const token = req.header("Authorization");

  if (!token) {
    return res.status(401).json({ error: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.userId = decoded.userId;
    next(); // Pass control to the next middleware or route handler
  } catch (err) {
    res.status(401).json({ error: "Token is not valid" });
  }
};

// API endpoint for user registration
app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    // Hash the password with a salt round of 10
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email",
      [username, email, password_hash]
    );

    const newUser = result.rows[0];

    // Create a JWT
    const token = jwt.sign({ userId: newUser.id }, jwtSecret, {
      expiresIn: "1h",
    });

    res
      .status(201)
      .json({ message: "User registered successfully", token, user: newUser });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      // PostgreSQL error code for unique constraint violation
      return res
        .status(400)
        .json({ error: "Username or email already exists" });
    }
    res.status(500).json({ error: "Server error during registration" });
  }
});

// API endpoint for user login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Find the user by username
    const userResult = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    if (userResult.rowCount === 0) {
      return res.status(400).json({ error: "Invalid username or password" });
    }

    const user = userResult.rows[0];

    // Compare the provided password with the stored hash
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid username or password" });
    }

    // Passwords match, so create a JWT
    const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: "1h" });

    res
      .status(200)
      .json({
        message: "Logged in successfully",
        token,
        user: { id: user.id, username: user.username },
      });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error during login" });
  }
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error("Error acquiring client", err.stack);
  }
  console.log("Successfully connected to the database!");
  release();
});

// API route to create a new expense
app.post("/expenses", authMiddleware, async (req, res) => {
  const { amount, description, category, created_at } = req.body;
  const userId = req.userId; // Get the user ID from the middleware

  try {
    const result = await pool.query(
      "INSERT INTO expenses (amount, description, category, created_at, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [amount, description, category, created_at, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add expense" });
  }
});

// API route to get all expenses for a specific month and year
app.get("/expenses", authMiddleware, async (req, res) => {
  const { month, year } = req.query;
  const userId = req.userId; // Get the user ID from the middleware

  try {
    let query = "SELECT * FROM expenses WHERE user_id = $3";
    const params = [month, year, userId];

    if (month && year) {
      query +=
        " AND EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2";
    }

    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve expenses" });
  }
});

// API route to get category-wise expense summary for a specific month and year
app.get("/reports/category-summary", authMiddleware, async (req, res) => {
  const { month, year } = req.query;
  const userId = req.userId; // Get the user ID from the middleware

  try {
    let query =
      "SELECT category, SUM(amount) AS total_amount FROM expenses WHERE user_id = $3";
    const params = [month, year, userId];

    if (month && year) {
      query +=
        " AND EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2";
    }

    query += " GROUP BY category ORDER BY total_amount DESC";
    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve report data" });
  }
});

// API route to delete an expense
app.delete("/expenses/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId; // Get the user ID from the middleware

  try {
    const result = await pool.query(
      "DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId]
    );
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Expense not found or not authorized" });
    }
    res.status(200).json({ message: "Expense deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
