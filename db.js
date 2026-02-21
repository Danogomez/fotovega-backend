require("dotenv").config()
const express = require("express")
const cors = require("cors")
const pool = require("./config/db")

const app = express()

app.use(cors())
app.use(express.json())

app.get("/", (req, res) => {
  res.send("Backend funcionando 🚀")
})

app.post("/api/contact", async (req, res) => {
  const { name, email, message } = req.body

  try {
    const newContact = await pool.query(
      "INSERT INTO contacts (name, email, message) VALUES ($1, $2, $3) RETURNING *",
      [name, email, message]
    )

    res.status(201).json(newContact.rows[0])
  } catch (err) {
    console.error(err.message)
    res.status(500).json({ error: "Error al guardar contacto" })
  }
})

app.listen(4000, () => {
  console.log("Servidor en puerto 4000 🚀")
})
