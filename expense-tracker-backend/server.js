require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 5001;

// Create a new Pool instance
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

// Middleware
app.use(express.json());
app.use(cors());

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error("Error acquiring client", err.stack);
  }
  console.log("Successfully connected to the database!");
  release();
});

// A simple test route
app.get("/", (req, res) => {
  res.send("Hello from the backend!");
});

// API route to create a new expense
app.post("/expenses", async (req, res) => {
  const { amount, description, category } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO expenses (amount, description, category) VALUES ($1, $2, $3) RETURNING *",
      [amount, description, category]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add expense" });
  }
});

// API route to get all expenses
app.get("/expenses", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM expenses ORDER BY created_at DESC"
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve expenses" });
  }
});

// API route to get category-wise expense summary
app.get("/reports/category-summary", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT category, SUM(amount) AS total_amount FROM expenses GROUP BY category ORDER BY total_amount DESC"
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve report data" });
  }
});

// API route to delete an expense
app.delete("/expenses/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM expenses WHERE id = $1 RETURNING *",
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Expense not found" });
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
