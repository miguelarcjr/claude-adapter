#!/bin/bash
# Script de Atualização para Mac/Linux (Zero Git)

REPO_URL="https://github.com/miguelarcjr/claude-adapter/archive/refs/heads/main.zip"
ZIP_FILE="update.zip"
EXTRACT_DIR="temp_update_folder"

echo "🔄 Iniciando atualização do Claude Adapter (via Github ZIP)..."

# 1. Baixar o arquivo .zip mais recente da main branch
echo "📥 Baixando código-fonte mais recente..."
curl -L -o "$ZIP_FILE" "$REPO_URL"

# 2. Descompactar em uma pasta temporária (instalando unzip se necessário)
echo "📦 Descompactando arquivos..."
rm -rf "$EXTRACT_DIR"
unzip -q "$ZIP_FILE" -d "$EXTRACT_DIR"

# A pasta extraída geralmente se chama claude-adapter-main
EXTRACTED_SUBFOLDER=$(ls -d "$EXTRACT_DIR"/* | head -n 1)

# 3. Copiar os arquivos substituindo os antigos
echo "🚀 Copiando arquivos novos para a raiz do projeto..."
# Usamos rsync se possível para merge suave, ou cp como fallback seguro
if command -v rsync >/dev/null 2>&1; then
    rsync -av --exclude node_modules/ --exclude .git/ --exclude .env "$EXTRACTED_SUBFOLDER/" ./
else
    cp -R "$EXTRACTED_SUBFOLDER"/* ./
fi

# 4. Limpeza da lixeira temporária
echo "🧹 Limpando arquivos temporários..."
rm -rf "$ZIP_FILE" "$EXTRACT_DIR"

echo "✅ Atualização finalizada com secusso!"
echo "⚠️ Lembre-se de rodar 'npm install' e 'npm run build' se houverem novos pacotes."
