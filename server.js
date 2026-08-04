const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');
const indexFile = path.join(publicDirectory, 'index.html');

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'Travel Partner Viajes Casal'
  });
});

app.use(express.static(publicDirectory, {
  index: false,
  dotfiles: 'ignore'
}));

app.get('*', (req, res, next) => {
  const isAppRoute = req.accepts('html') && !path.extname(req.path) && !req.path.startsWith('/api/');

  if (!isAppRoute) {
    return next();
  }

  return res.sendFile(indexFile);
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Recurso no encontrado'
  });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    ok: false,
    error: status >= 500 ? 'Error interno del servidor' : 'Solicitud inválida'
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Travel Partner Viajes Casal disponible en http://localhost:${PORT}`);
  });
}

module.exports = app;
