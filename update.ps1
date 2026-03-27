# Script para atualizar o Claude Adapter baixando direto do GitHub (Sem Git)
$repoUrl = "https://github.com/miguelarcjr/claude-adapter/archive/refs/heads/main.zip"
$zipFile = "update.zip"
$extractFolder = "temp_update_folder"

Write-Host "Iniciando atualizacao do Claude Adapter..." -ForegroundColor Cyan

# 1. Faz o download do código-fonte (ZIP) da branch main
Write-Host "Baixando os arquivos mais recentes do GitHub..."
Invoke-WebRequest -Uri $repoUrl -OutFile $zipFile

# 2. Descompacta o arquivo ZIP
Write-Host "Extraindo os arquivos..."
If (Test-Path $extractFolder) { Remove-Item -Path $extractFolder -Recurse -Force }
Expand-Archive -Path $zipFile -DestinationPath $extractFolder -Force

# 3. Descobre o nome da pasta descompactada (geralmente claude-adapter-main)
$extractedSubFolder = Get-ChildItem -Path $extractFolder | Select-Object -First 1

# 4. Copia os arquivos atualizados substituindo os antigos, exceto arquivos de configuração locais e node_modules
Write-Host "Atualizando projeto local..."
$sourcePath = "$($extractedSubFolder.FullName)\*"

# Copia tudo sobrescrevendo, o Copy-Item com -Force sobrescreve os arquivos modificados.
# Nota: Suas variaveis .env nao restam no Github, logo nao serao apagadas do seu PC, apenas ignoramos para garantir.
Copy-Item -Path $sourcePath -Destination ".\" -Recurse -Force

# 5. Limpeza de arquivos temporários do download
Write-Host "Limpando aquivos temporários..."
Remove-Item -Path $zipFile -Force
Remove-Item -Path $extractFolder -Recurse -Force

Write-Host "`nAtualizacao finalizada com sucesso!" -ForegroundColor Green
Write-Host "Lembre-se de rodar 'npm install' caso as dependências tenham mudado." -ForegroundColor Yellow
