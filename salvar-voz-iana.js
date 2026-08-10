// salvar-voz-iana.js
// Uso: node salvar-voz-iana.js <generated_voice_id>
// (o generated_voice_id vem da saída do desenhar-voz-iana.js, depois de
// você escolher qual das 3 prévias curtiu mais)

import 'dotenv/config';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const generatedVoiceId = process.argv[2];

if (!API_KEY) {
    console.error('❌ Defina ELEVENLABS_API_KEY no .env.');
    process.exit(1);
}
if (!generatedVoiceId) {
    console.error('❌ Uso: node salvar-voz-iana.js <generated_voice_id>');
    process.exit(1);
}

async function main() {
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-voice', {
        method: 'POST',
        headers: {
            'xi-api-key': API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            voice_name: 'Iana',
            voice_description: 'Voz oficial da assistente Iana — gamer, energética, brasileira.',
            generated_voice_id: generatedVoiceId
        })
    });

    if (!res.ok) {
        console.error('❌ Erro ao salvar a voz:', res.status, await res.text());
        process.exit(1);
    }

    const dados = await res.json();
    console.log('\n✅ Voz da Iana salva permanentemente!');
    console.log(`\n👉 Coloque isso no seu .env (e no Render):\n`);
    console.log(`ELEVENLABS_VOICE_ID=${dados.voice_id}\n`);
}

main().catch(e => { console.error('❌ Erro:', e.message); process.exit(1); });