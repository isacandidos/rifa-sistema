# 🎟️ Sistema de Rifa - Centro Espírita Vô Horácio

Sistema de gerenciamento de rifas com Node.js/Express + PostgreSQL.

## 🗂️ Estrutura

```
rifa/
├── backend/
│   ├── server.js         # API REST (Express + PostgreSQL)
│   ├── package.json
│   ├── railway.toml      # Config de deploy
│   └── .env.example      # Variáveis de ambiente
└── frontend/
    └── public/
        ├── index.html    # Página pública de compra
        └── admin.html    # Painel administrativo
```

## 🚀 Deploy no Railway (recomendado)

### 1. Criar banco PostgreSQL
- Acesse [railway.app](https://railway.app) e faça login com GitHub
- Clique em **New Project** → **Deploy from GitHub repo**
- Selecione seu repositório
- Clique em **New** → **Database** → **PostgreSQL**
- O Railway cria automaticamente a variável `DATABASE_URL`

### 2. Configurar o serviço backend
- Clique no serviço Node.js
- Vá em **Settings** → **Root Directory** → coloque `backend`
- Em **Variables**, confirme que `DATABASE_URL` está presente (vem do banco)
- Adicione também: `NODE_ENV=production`

### 3. Pegar a URL pública
- Vá em **Settings** → **Networking** → **Generate Domain**
- Você receberá algo como: `https://rifa-production.up.railway.app`

### 4. Atualizar o frontend
Nos arquivos `index.html` e `admin.html`, substitua:
```
http://localhost:3001
```
pela URL gerada, ex:
```
https://rifa-production.up.railway.app
```
Depois faça commit e push — o Railway redeploya automaticamente.

## 💻 Rodar localmente

```bash
cd backend
cp .env.example .env
# Edite .env com sua DATABASE_URL local
npm install
npm start
```

## 🔑 Credenciais padrão

- **Usuário:** `admin`  
- **Senha:** `1234`

> ⚠️ Troque em produção editando diretamente o `server.js`

## 📡 Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/numbers` | Lista todos os números e status |
| POST | `/api/reserve` | Reserva números (30 min) |
| POST | `/api/confirm/:id` | Confirma pagamento (admin) |
| POST | `/api/cleanup` | Expira reservas antigas manualmente |
| POST | `/api/admin/login` | Login admin |
| GET | `/api/admin/dashboard` | Dashboard com estatísticas |
| DELETE | `/api/admin/purchase/:id` | Remove compra |

## 🗄️ Tabelas do banco

- **`numbers`** — status de cada número (available / reserved / sold)
- **`purchases`** — dados do comprador e pagamento
- **`purchase_numbers`** — relação entre compras e números

As tabelas são criadas automaticamente na primeira execução.
