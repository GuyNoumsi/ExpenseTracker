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

    res.status(200).json({
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

// New API route to get daily expense summary for a specific month and year
app.get("/reports/monthly-summary", authMiddleware, async (req, res) => {
  const { month, year } = req.query;
  const userId = req.userId;

  try {
    const query = `
            SELECT
                EXTRACT(DAY FROM created_at) AS day,
                SUM(amount) AS total_amount
            FROM expenses
            WHERE
                user_id = $3
                AND EXTRACT(MONTH FROM created_at) = $1
                AND EXTRACT(YEAR FROM created_at) = $2
            GROUP BY
                day
            ORDER BY
                day ASC;
        `;
    const result = await pool.query(query, [month, year, userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve monthly summary data" });
  }
});

// New API route for weekly category summary
app.get(
  "/reports/weekly-category-summary",
  authMiddleware,
  async (req, res) => {
    const { startDate, endDate } = req.query;
    const userId = req.userId;

    try {
      const query = `
            SELECT
                category,
                SUM(amount) AS total_amount
            FROM expenses
            WHERE
                user_id = $3
                AND created_at BETWEEN $1 AND $2
            GROUP BY
                category
            ORDER BY
                total_amount DESC;
        `;
      const result = await pool.query(query, [startDate, endDate, userId]);
      res.status(200).json(result.rows);
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ error: "Failed to retrieve weekly category summary" });
    }
  }
);

// New API route for yearly category summary
app.get(
  "/reports/yearly-category-summary",
  authMiddleware,
  async (req, res) => {
    const { year } = req.query;
    const userId = req.userId;

    try {
      const query = `
            SELECT
                category,
                SUM(amount) AS total_amount
            FROM expenses
            WHERE
                user_id = $2
                AND EXTRACT(YEAR FROM created_at) = $1
            GROUP BY
                category
            ORDER BY
                total_amount DESC;
        `;
      const result = await pool.query(query, [year, userId]);
      res.status(200).json(result.rows);
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ error: "Failed to retrieve yearly category summary" });
    }
  }
);

// New API route to get monthly expense summary for a specific year
app.get("/reports/yearly-summary", authMiddleware, async (req, res) => {
  const { year } = req.query;
  const userId = req.userId;

  try {
    const query = `
            SELECT
                EXTRACT(MONTH FROM created_at) AS month,
                SUM(amount) AS total_amount
            FROM expenses
            WHERE
                user_id = $2
                AND EXTRACT(YEAR FROM created_at) = $1
            GROUP BY
                month
            ORDER BY
                month ASC;
        `;
    const result = await pool.query(query, [year, userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve yearly summary data" });
  }
});

// New API route to get daily expense summary for a specific week
app.get("/reports/weekly-summary", authMiddleware, async (req, res) => {
  const { startDate, endDate } = req.query;
  const userId = req.userId;

  try {
    const query = `
            SELECT
                created_at::date AS day,
                SUM(amount) AS total_amount
            FROM expenses
            WHERE
                user_id = $3
                AND created_at BETWEEN $1 AND $2
            GROUP BY
                day
            ORDER BY
                day ASC;
        `;
    const result = await pool.query(query, [startDate, endDate, userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve weekly summary data" });
  }
});
// API route to update an expense
app.put("/expenses/:id", authMiddleware, async (req, res) => {
  const expenseId = parseInt(req.params.id);
  const { amount, description, category, created_at } = req.body;
  const userId = req.userId;

  try {
    const query = `
            UPDATE expenses
            SET amount = $1, description = $2, category = $3, created_at = $4
            WHERE id = $5 AND user_id = $6
            RETURNING *;
        `;
    const result = await pool.query(query, [
      amount,
      description,
      category,
      created_at,
      expenseId,
      userId,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Expense not found or you do not have permission to edit it.",
      });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update expense" });
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

// New API route to get all expenses for a custom date range
app.get("/expenses/range", authMiddleware, async (req, res) => {
  const { startDate, endDate } = req.query;
  const userId = req.userId;

  try {
    const query = `
          SELECT id, amount, description, category, created_at
          FROM expenses
          WHERE user_id = $3 AND created_at::date BETWEEN $1 AND $2
          ORDER BY created_at DESC;
      `;
    const result = await pool.query(query, [startDate, endDate, userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Failed to retrieve expenses for the date range" });
  }
});

// New API route for category summary over a custom date range
app.get("/reports/range-category-summary", authMiddleware, async (req, res) => {
  const { startDate, endDate } = req.query;
  const userId = req.userId;

  try {
    const query = `
          SELECT
              category,
              SUM(amount) AS total_amount
          FROM expenses
          WHERE
              user_id = $3
              AND created_at::date BETWEEN $1 AND $2
          GROUP BY
              category
          ORDER BY
              total_amount DESC;
      `;
    const result = await pool.query(query, [startDate, endDate, userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve category summary" });
  }
});

// New API route for daily spending summary over a custom date range
app.get("/reports/range-daily-summary", authMiddleware, async (req, res) => {
  const { startDate, endDate } = req.query;
  const userId = req.userId;

  try {
    const query = `
          SELECT
              created_at::date AS day,
              SUM(amount) AS total_amount
          FROM expenses
          WHERE
              user_id = $3
              AND created_at::date BETWEEN $1 AND $2
          GROUP BY
              day
          ORDER BY
              day ASC;
      `;
    const result = await pool.query(query, [startDate, endDate, userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve daily summary" });
  }
});

// API route to get categories for a logged-in user
app.get("/categories", authMiddleware, async (req, res) => {
  const userId = req.userId;
  try {
    const query =
      "SELECT name FROM categories WHERE user_id = $1 ORDER BY name ASC";
    const result = await pool.query(query, [userId]);
    res.status(200).json(result.rows.map((row) => row.name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve categories" });
  }
});

// API route to add a new category for a logged-in user
app.post("/categories", authMiddleware, async (req, res) => {
  const { name } = req.body;
  const userId = req.userId;

  if (!name) {
    return res.status(400).json({ error: "Category name is required" });
  }

  try {
    const query =
      "INSERT INTO categories (name, user_id) VALUES ($1, $2) RETURNING name";
    const result = await pool.query(query, [name, userId]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      // PostgreSQL unique violation error code
      return res.status(409).json({ error: "Category already exists" });
    }
    res.status(500).json({ error: "Failed to add category" });
  }
});

// API route to delete a category
app.delete("/categories", authMiddleware, async (req, res) => {
  const { name } = req.body;
  const userId = req.userId;

  if (!name) {
    return res.status(400).json({ error: "Category name is required" });
  }

  try {
    // Ensure category is user-defined and not a hardcoded one (we'll implement this on the frontend)
    const query =
      "DELETE FROM categories WHERE name = $1 AND user_id = $2 RETURNING *";
    const result = await pool.query(query, [name, userId]);

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({
          error:
            "Category not found or you do not have permission to delete it.",
        });
    }

    res.status(200).json({ message: "Category deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

const server = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

  // Stop accepting new requests
  server.close(() => {
    console.log("HTTP server closed.");
  });

  // Close database pool
  await pool.end();
  console.log("Database pool closed.");

  process.exit(0);
};

// Listen for shutdown signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
