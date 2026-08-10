// desenhar-voz-iana.js
// Rode UMA VEZ (node desenhar-voz-iana.js) pra criar a voz exclusiva da Iana.
// Depois disso, guarde o voice_id impresso no final — ele vai pro .env como
// ELEVENLABS_VOICE_ID e nunca mais precisa rodar esse script de novo
// (a menos que queira desenhar uma voz diferente).

import 'dotenv/config';

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
    console.error('❌ Defina ELEVENLABS_API_KEY no .env antes de rodar esse script.');
    process.exit(1);
}

// AJUSTE AQUI a descrição da voz que você quer pra Iana.
// Seja específico: idade, sotaque, energia, tom, personalidade.
const DESCRICAO_VOZ =
    'Voz feminina jovem, brasileira, sotaque neutro do Brasil, energética e ' +
    'animada, tom confiante e levemente brincalhão, como uma gamer experiente ' +
    'falando com um amigo. Ritmo ágil, expressiva, sem ser exagerada.';

const TEXTO_PREVIA =
    'E aí! Bora fechar essa platina hoje? Eu já sei exatamente onde ficam os ' +
    'itens que faltam, é só me seguir que a gente resolve isso rapidinho!';

async function main() {
    console.log('🎨 Gerando 3 opções de voz...\n');

    const resDesign = await fetch('https://api.elevenlabs.io/v1/text-to-voice/design', {
        method: 'POST',
        headers: {
            'xi-api-key': API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            voice_description: DESCRICAO_VOZ,
            text: TEXTO_PREVIA,
            model_id: 'eleven_multilingual_ttv_v2'
        })
    });

    if (!resDesign.ok) {
        console.error('❌ Erro ao gerar previews:', resDesign.status, await resDesign.text());
        process.exit(1);
    }

    const dados = await resDesign.json();
    const previews = dados.previews || [];

    if (!previews.length) {
        console.error('❌ Nenhuma preview gerada.');
        process.exit(1);
    }

    console.log(`✅ ${previews.length} opções geradas. IDs:\n`);
    previews.forEach((p, i) => {
        console.log(`  [${i}] generated_voice_id: ${p.generated_voice_id}`);
    });

    console.log(
        '\n👉 Ainda não salvei nenhuma. Ouça as prévias (o SDK/dashboard da ' +
        'ElevenLabs toca esses generated_voice_id) e escolha uma.\n' +
        'Depois rode: node salvar-voz-iana.js <generated_voice_id_escolhido>\n'
    );
}

main().catch(e => { console.error('❌ Erro:', e.message); process.exit(1); });