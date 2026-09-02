
import asyncio
import edge_tts
import os
import subprocess

alerts = [
    {
        "id": "raid_alert",
        "voice": "en-US-ChristopherNeural",
        "text": "Attention all team members. Priority one raid alert. The core smart alarm has been triggered on the main compound. Check base security and prepare to defend immediately."
    },
    {
        "id": "cargo_ship_alert",
        "voice": "en-US-ChristopherNeural",
        "text": "Tactical announcement. The Cargo Ship has spawned and is navigating toward the island harbor. All squads prepare for interception."
    },
    {
        "id": "patrol_heli_alert",
        "voice": "en-US-ChristopherNeural",
        "text": "Air defense alert. Patrol Helicopter is inbound near sector Golf Fourteen. Ensure roof surface-to-air missiles are armed and operational."
    },
    {
        "id": "oilrig_crate_alert",
        "voice": "en-US-ChristopherNeural",
        "text": "Monument event notice. The locked crate at Large Oil Rig has been activated. Heavy scientists deployed."
    },
    {
        "id": "test_voice_alert",
        "voice": "en-US-ChristopherNeural",
        "text": "Rust Plus Sentinel Node online. Voice communication channel verified and active in the Matrix tactical room. System status: fully operational."
    }
]

async def generate():
    os.makedirs("/opt/rustplus-manager/data/audio", exist_ok=True)
    for item in alerts:
        aid = item["id"]
        v = item["voice"]
        txt = item["text"]
        mp3_path = f"/opt/rustplus-manager/data/audio/{aid}.mp3"
        wav_path = f"/opt/rustplus-manager/data/audio/{aid}.wav"
        print(f"Generating {aid} with {v}...")
        communicate = edge_tts.Communicate(txt, v, rate="+0%", pitch="+0Hz")
        await communicate.save(mp3_path)
        
        subprocess.run([
            "ffmpeg", "-y", "-i", mp3_path,
            "-ar", "48000", "-ac", "1", wav_path
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"Saved {wav_path}")

asyncio.run(generate())
