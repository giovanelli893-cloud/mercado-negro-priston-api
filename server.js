import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// rota de saúde (teste do Render)
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API Mercado Negro Priston rodando na porta ${PORT}`);
});
