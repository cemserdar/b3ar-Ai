// @ts-check
'use strict';
const vscode = require('vscode');
const fs = require('fs/promises');
const { getWorkspaceRoot, resolveSafePath, listWorkspaceFiles, ensureMcpState } = require('./workspace');

// Örnek id'leri "ornek_" ile başlar: tarayıcı content script'i bunları ASLA çalıştırmaz.
const TOOL_MANUAL = `### KULLANABİLECEĞİN MCP ARAÇLARI (XML FORMATI)
Her çağrıya benzersiz bir \`id\` ver (örn: \`req_101\`; aşağıdaki \`ornek_*\` id'lerini ASLA kullanma) ve kod/metin parametrelerini mutlaka \`<![CDATA[ ... ]]>\` içine al.

1. **Dizin Listeleme:**
<mcp_call id="ornek_01" tool="list_directory">
  <param name="path">.</param>
</mcp_call>

2. **Dosya Okuma:**
<mcp_call id="ornek_02" tool="read_file">
  <param name="path">src/index.ts</param>
</mcp_call>

3. **Dosya Yazma / Oluşturma:**
<mcp_call id="ornek_03" tool="write_file">
  <param name="path">src/utils/helper.ts</param>
  <param name="content"><![CDATA[
// tam dosya içeriği
  ]]></param>
</mcp_call>

4. **Kısmi Kod Değişikliği (Diff):**
<mcp_call id="ornek_04" tool="apply_diff">
  <param name="path">src/utils/helper.ts</param>
  <param name="search"><![CDATA[
// mevcut kod (birebir aynı)
  ]]></param>
  <param name="replace"><![CDATA[
// yeni kod
  ]]></param>
</mcp_call>

5. **Terminal Komutu:**
<mcp_call id="ornek_05" tool="run_command">
  <param name="command">npm test</param>
</mcp_call>

**KURALLAR:**
- İnternette arama yapma, sadece yukarıdaki XML araçlarını kullan.
- Kod bloklarının içine ASLA \`// ... mevcut kodlar\` gibi kısaltmalar yazma.
- Mevcut içeriğini bilmediğin dosyaya \`apply_diff\` yapma; önce \`read_file\` ile oku.
- \`apply_diff\` için "search" bloğu dosyada TEK bir yeri işaret etmeli; gerekirse çevre satırları ekle.
- Terminal komutları kullanıcı onayından geçer; reddedilirse alternatif yol öner.
- Her önemli adımda \`.mcp/STATE.md\` dosyasını güncelle.`;

const ROLE_INSTRUCTIONS = {
  solo: () => 'Sen VS Code içine gömülü otonom bir Kıdemli Yazılım Mühendisisin. Bundan sonra sana göndereceğim görevleri aşağıdaki MCP araçlarını kullanarak doğrudan proje dosyaları üzerinde uygula.',
  architect: () => 'Sen Kıdemli Yazılım Mimarısın. Uygulama kodlarını DEĞİŞTİRME; sadece dosyaları incele, teknik planı `.mcp/PLAN.md` dosyasına yaz ve plan bitince yanıtının en altına `<handoff_to_coder/>` etiketini koy.',
  /** @param {string} mode */
  coder: (mode) => `Sen Kıdemli Geliştiricisin. \`.mcp/PLAN.md\` planını ve verilen görevleri koda dök. ${mode === '3' ? 'Bitince yanıtının en altına `<handoff_to_reviewer/>` koy.' : 'Bitince özet rapor ver.'}`,
  reviewer: () => 'Sen Kod Denetçisisin. Yapılan değişiklikleri incele; hata varsa `.mcp/PLAN.md` içine yazıp `<handoff_to_coder/>` gönder, sorun yoksa onay raporu sun.'
};

/** @param {{ role?: string, mode?: string }} opts */
async function buildSystemSetupPrompt({ role = 'solo', mode = '1' }) {
  const root = getWorkspaceRoot();
  const { state, plan } = await ensureMcpState(root);
  const workspaceFiles = await listWorkspaceFiles();
  const fileTreeSummary = workspaceFiles.slice(0, 150).map(f => `- ${f}`).join('\n');
  const roleInstruction = (ROLE_INSTRUCTIONS[role] || ROLE_INSTRUCTIONS.solo)(mode);

  return `${roleInstruction}

${TOOL_MANUAL}

---
### MEVCUT PROJE DOSYA AĞACI (İlk 150 Dosya)
${fileTreeSummary || '(Henüz dosya yok veya boş dizin)'}

### OTONOM DOSYA HEDEFLEME & OLUŞTURMA KURALI:
1. **Hedef Dosyayı Kendin Belirle:** Kullanıcının sana dosya yolu vermesini bekleme. Verilen göreve göre (örn: login sayfası, veritabanı modeli, navbar bileşeni) projenin dosya ağacını inceleyerek en uygun dosya yolunu SEN SEÇ.
2. **Otomatik Yeni Dosya / Sayfa Oluştur:** Eğer dosya mevcut değilse doğrudan \`<mcp_call tool="write_file">\` aracını kullanarak dosyayı oluştur. Sistem gerekli tüm alt klasörleri otomatik oluşturacaktır.
3. **Kod Bloğu Başlığı:** Normal metin içinde verdiğin her kod bloğunun ilk satırına hedef dosya yolunu yorum satırı olarak ekle:
   \`// filepath: src/pages/Contact.tsx\` veya \`# filepath: app/models/user.py\`

---
### PROJE HAFIZASI (.mcp/STATE.md)
${state}

### MİMARİ PLAN (.mcp/PLAN.md)
${plan}

Kuralları anladığını kısaca onayla, ben sana görevimi ileteceğim.`;
}

/** @param {{ userPrompt: string, includeActiveFile?: boolean, mentionedFiles?: string[] }} opts */
async function buildCleanUserMessage({ userPrompt, includeActiveFile, mentionedFiles = [] }) {
  const attachedFilesMap = new Map();

  for (const relPath of mentionedFiles) {
    try {
      attachedFilesMap.set(relPath, await fs.readFile(resolveSafePath(relPath), 'utf-8'));
    } catch {}
  }

  if (includeActiveFile && vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    if (!attachedFilesMap.has(relPath) && !relPath.startsWith('.mcp/')) {
      attachedFilesMap.set(relPath, doc.getText());
    }
  }

  if (attachedFilesMap.size === 0) return userPrompt;

  let filesContextBlock = '\n\n---\n### EKLENEN DOSYALAR\n';
  for (const [relPath, content] of attachedFilesMap.entries()) {
    filesContextBlock += `\n#### \`${relPath}\`\n\`\`\`\n${content}\n\`\`\`\n`;
  }
  return `${userPrompt}${filesContextBlock}`;
}

/** @param {string} relPath @param {string} fullText @param {string} code */
function buildAutoPatchPrompt(relPath, fullText, code) {
  return `Aşağıdaki kod parçasını mevcut \`${relPath}\` dosyasına dosyayı bozmadan entegre et. Sadece \`<mcp_call tool="apply_diff">\` aracını kullanarak yamayı uygula, başka açıklama yazma.

### MEVCUT DOSYA (\`${relPath}\`)
\`\`\`
${fullText}
\`\`\`

### ENTEGRE EDİLECEK YENİ KOD PARÇASI
\`\`\`
${code}
\`\`\``;
}

module.exports = { TOOL_MANUAL, buildSystemSetupPrompt, buildCleanUserMessage, buildAutoPatchPrompt };
