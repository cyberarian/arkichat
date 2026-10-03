<div align="right">
  <img src="logo.svg" width="104" alt="Arki Chat">
</div>

# Arki Chat 🟦

Teman asisten berbentuk *squircle* yang tinggal di peramban Anda — dan pintu masuk yang lebih
ramah bagi [Ollama](https://ollama.com). Model lokal yang sama, tanpa dasbor-developer. Setiap
balasan dihasilkan secara lokal: tanpa API key, tanpa cloud, tanpa proses build, **tanpa
ketergantungan npm sama sekali**.

Tapi Arki bukan sekadar menjawab. Arki bisa **bertindak**: mencari di YouTube lalu memutar lofi di
player bawaan sembari Anda mengobrol, membuka Gmail atau GitHub di tab untuk Anda, dan mendengarkan
kata pemicu **“Arki”** sehingga Anda bisa menjeda musik tanpa menyentuh keyboard.

> **Maintainer** — Adnuri Mohamidi

```bash
ollama serve        # 1. Ollama jalan
node server.js      # 2. Arki (tidak ada yang perlu diinstal)
open http://localhost:5177
```

![Arki Chat di desktop, memutar lofi di sidebar sambil mengobrol](screenshots/desktop.png)

<p align="center">
  <img src="screenshots/mobile.png" width="300" alt="Arki Chat di ponsel">
</p>

<p align="center">
  <img src="screenshots/about.png" width="620" alt="Halaman tentang Arki Chat">
</p>

> 🌐 **Bahasa:** Indonesia · [English](README.en.md)

---

## Daftar Isi

- [Mulai Cepat](#mulai-cepat)
- [Kenapa](#kenapa)
- [Tools — Arki bisa bertindak](#tools--arki-bisa-bertindak)
- [Memutar musik di halaman](#memutar-musik-di-halaman)
- [Kata pemicu](#kata-pemicu)
- [Perintah slash](#perintah-slash)
- [Fitur chat](#fitur-chat)
- [Avatar](#avatar)
- [Keyboard](#keyboard)
- [Responsif](#responsif)
- [Konfigurasi](#konfigurasi)
- [Cara kerjanya](#cara-kerjanya)
- [Yang diingat](#yang-diingat)
- [Pemecahan masalah](#pemecahan-masalah)
- [Baik untuk diketahui](#baik-untuk-diketahui)
- [Brand](#brand)
- [Berkas](#berkas)
- [Kredit](#kredit)
- [Lisensi](#lisensi)

---

## Mulai Cepat

**Kebutuhan:** Node 18+ (dikembangkan di Node 24) dan Ollama yang sedang berjalan dengan minimal
satu model chat.

```bash
# 1. Instal Ollama lalu tarik model yang Anda sukai
ollama pull qwen3.5:2b

# 2. Jalankan Arki — tanpa npm install, tidak ada dependensi
node server.js

# 3. Buka http://localhost:5177
```

Kalau ingin tahu dulu apa yang akan Anda dapat, baca [halaman Tentang](about.html) lebih dulu.

Jika port 5177 sedang dipakai, Arki dengantenang naik ke port bebas berikutnya dan mencetak URL
yang dipakainya.

Tidak ada yang diinstal, dibangun, atau di-*bundle*. `index.html` adalah seluruh frontend-nya;
`server.js` adalah server statik ~150 baris plus sebuah proxy.

---

## Kenapa

Ollama adalah cara paling ramah untuk menjalankan model di mesin Anda sendiri, dan diam-diam ia
telah menjadi "otak lokal" bawaan banyak orang. Tapi antarmuka web-nya tidak pernah dirancang
untuk *dipakai* — dirancang untuk *diperiksa*. Parameter model, jumlah token, konsep berbentuk
curl. Ia menjawab pertanyaan "apakah model saya jalan?" dengan sangat indah, dan "sebenarnya apa
yang saya mau?" sama sekali tidak.

Arki Chat adalah pintu depan yang lain. Model sama, mesin sama, privasi sama — tapi yang ini
*teman*, bukan dasbor:

- **Siapa pun bisa mulai.** `ollama serve`, `node server.js`, selesai. Tanpa Docker, tanpa Python,
  tanpa unduhan bobot, tanpa berkas konfigurasi.
- **Tidak perlu kosakata teknis.** Anda tidak memilih model berdasarkan jumlah parameter; Anda
  memilih yang hasilnya cocok, dan Arki memberi tahu mana yang bisa melihat gambar.
- **Ia melakukan sesuatu, bukan sekadar menjawab.** Minta lofi dan ia memutar sambil Anda bicara.
  Minta Gmail Anda dan ia membukanya.
- **Ia jujur.** Setiap balasan mencantumkan model, waktu tempuh, dan laju token. Setiap pemanggilan
  tool menampilkan persis apa yang dilakkukan. Model lokal kecil memang tidak sempurna; Arki tidak
  pernah menyembunyikannya.
- **Pas di layar Anda.** Lebar 320px atau 2560 — aplikasi yang sama, dan versi ponselnya justru
  yang justru paling bagus.

Bagi siapa pun yang sudah nyaman di terminal, antarmuka Ollama sendiri tetaplah alat yang tepat.
Ini untuk orang yang sudah menjalankan Ollama tapi belum tahu harus apa selanjutnya.

---

## Tools — Arki bisa bertindak

Empat tool ditempelkan pada setiap permintaan. Ketika model memutuskan sebuah tool dibutuhkan, ia
menghasilkan entri `tool_calls`, Arki menjalankannya secara lokal, lalu hasil nyatanya dikembalikan
supaya model bisa mengonfirmasi apa yang benar-benar terjadi.

| Tool | Parameter | Fungsinya |
|---|---|---|
| `play_music` | `query`, `service?` | Mencari di YouTube dan memutar hasil teratas di player sidebar. Terima juga URL YouTube, tautan track/album/playlist atau URI Spotify, maupun URL file audio langsung. |
| `control_music` | `action` | `pause` · `resume` · `stop` · `next` pada player sidebar. |
| `set_volume` | `level` | Volume di dalam halaman, 0–100. |
| `open_app` | `name` | Membuka situs di tab baru — gmail, youtube, github, drive, calendar, maps, netflix, reddit, wikipedia, x, notion, figma, amazon, chatgpt, claude, weather, news, npm, huggingface, dan lainnya, lewat 41 pintasan nama untuk ~37 situs. URL lengkap apa pun bisa; nama yang tidak dikenali akan jatuh ke pencarian web. |

**Ke mana hasilnya ditampilkan.** Pemanggilan tool muncul sebagai kartu di sidebar di bawah
*Tool activity* — argumen dan hasil sebenarnya — dibatasi 8 terakhir dengan tombol **clear**.
Transkrip tetap bersih seperti percakapan biasa; Arki cukup menyebutkan apa yang ia lakukan, dalam
satu kalimat.

```
you    ▸ Play some calm jazz piano music for me
arka   ▸ Here's your track — smooth piano jazz is playing in the sidebar.
          ⚡ play_music  query="calm jazz piano"
            Now playing on YouTube: “4K Cozy Coffee Shop with Smooth Piano
            Jazz Music…” by Relaxing Jazz Piano (3 hours, 35 minutes).
```

**Detail yang perlu diketahui**

- Putarannya berjalan **hingga 4 putaran** per pesan, sehingga Arki dapat merangkai aksi (main,
  lalu atur volume, lalu konfirmasi).
- Jika sebuah model menolak array `tools`, Arki mencatatnya dan **mengulang percakapan tanpa tools**
  alih-alih gagal. Chat tidak pernah rusak karena itu.
- **6** aksi terakhir diringkas menjadi sebuah system message, sehingga pertanyaan lanjutan seperti
  *"mainkan yang berikutnya"* atau *"turunkan volumenya"* tetap jalan.
- Model lokal kecil memang terlalu eagerness — model 2B bisa saja memanggil
  `set_volume` dengan sendirinya. Deskripsi tool dan system prompt sama-sama menyatakan jangan
  begitu, tetapi kalau model tetap mengabaikannya, kartu di sidebar akan menampilkan persis apa
  yang ia lakukan.

**Tool-calling butuh model yang mendukungnya.** Terverifikasi bekerja di sini dengan
`qwen3.5:2b`, `granite4.2`, `gemma4`, `ornith-1.5:9b`, dan `Spark-X2.5-4B`. `phi4-mini` dan
`gemma2:9b` mengabaikan tools dan hanya mengobrol — dengan model seperti itu, semuanya tetap bisa
dilakukan lewat perintah slash.

---

## Memutar musik di halaman

Player-nya berada di **sidebar**, di bawah avatar, sehingga musik tidak pernah mengganggu kolom
percakapan.

```
❚❚ ■ ▾   4K Cozy Coffee Shop with Smooth Piano Jazz Music for Relaxing…
         YouTube · in-page player
         ┌────────────────┐
         │   video 16:9   │
         └────────────────┘
         ────────●────  ↗  ✕
```

- ❚❚ / ▶ jeda dan lanjutkan · ■ hentikan · ▾ sembunyikan video tetapi **audio tetap berjalan**
  (diingat antar sesi) · slider volume · ↗ buka sumbernya di tab · ✕ tutup
- Sidebar adalah dua sel yang menggulir secara independen: Arki tetap pada lebar penuh 290px dan
  player menggulir di bawahnya, jadi memulai lagu tidak akan mendorong Arki keluar dari bingkai
- Avatar menyala dengan cahaya ungu *Playing* setiap kali lagu dimulai

**Dari mana audionya**

- **YouTube** — tanpa API key. YouTube telah mematikan embed "search" publiknya, jadi `server.js`
  menyediakan `/api/ytsearch`: ia membaca halaman hasil pencarian sekali, mengambil id video asli
  beserta judul, channel, dan durasinya, lalu halaman tersebut menyematkan hasil teratas dengan
  player `youtube-nocookie`. Hasil di-cache di memori selama 10 menit.
- **Spotify** — tautan track, album, playlist, show, dan episode serta URI `spotify:` disematkan
  langsung ke halaman. Spotify tidak menyediakan *search* yang bisa disematkan, sehingga pencarian
  biasa (atau `service: "spotify"`) membuka `open.spotify.com/search/…` di tab baru dan Arki
  menyuruh Anda menempelkan tautan aslinya kembali untuk diputar di dalam halaman.
- **Berkas audio apa pun** — URL yang berakhiran `.mp3`, `.m4a`, `.aac`, `.ogg`, `.wav`, `.flac`,
  `.opus`, atau `.mp4` diputar pada elemen `<audio>` native, yang lalu bisa dijeda, dilewati, dan
  diatur volumenya seperti sumber mana pun.

> Peramban memblokir autoplay yang tidak di-*mute* sampai mereka menganggap Anda pendengar yang
> aktif. Kalau video tidak berjalan sendiri, tekan ▶ sekali (atau klik di dalam player) dan
> dan setelah itu ia tetap menemani Anda.

---

## Kata pemicu

Klik **🎤 Wake “Arki”** untuk mulai mendengarkan (Chrome atau Safari, dan Anda akan diminta izin
mikrofon satu kali).

| Anda ucapkan | Arki melakukan |
|---|---|
| *"Arki"* | menjeda musik — ucapkan lagi untuk melanjutkan |
| *"Arki, mainkan bossa nova"* | menganggap sisanya sebagai permintaan dan menjalankannya lewat tools |
| *"Arki, pause that"* | `"pause that"` dicocokkan sebagai perintah slash dan langsung dijalankan |

Saat mendengarkan, Arki berubah menjadi sian dengan status *Listening* dan menampilkan transkrip
langsung, sehingga Anda bisa melihat apa yang didengarnya. Klik `wake word: Arki` di bawah avatar
untuk mengganti kata tersebut — apa pun yang Anda mau, dicocokkan sebagai satu kata utuh.

Pengenalan suara memakai Web Speech API, yang **disediakan peramban** (di Chrome audio dikirim ke
Google untuk ditranskripsi) dan hanya ada di Chromium dan Safari. Firefox dan sejenisnya
mendapatkan pesan yang jelas di event log dan tombolnya otomatis dinonaktifkan. Perintah slash di
bawah melakukan pekerjaan yang sama tanpa mikrofon.

---

## Perintah slash

Perintah ini melewati model sepenuhnya dan menjalankan tool yang sama secara instan — berguna untuk
menguji, untuk peramban tanpa dukungan suara, dan ketika Anda hanya ingin agar sesuatu berhenti.

| Perintah | Contoh |
|---|---|
| `/play <query>` | `/play lofi hip hop beats` |
| `/pause` `/resume` `/stop` | `/pause` |
| `/next` atau `/skip` | `/next` |
| `/vol <0-100>` | `/vol 35` |
| `/open <app atau url>` | `/open gmail` |

---

## Fitur chat

- **Balasan streaming** token demi token, dengan tombol **Stop** yang berfungsi dan timer
  `thinking… 3s` / `writing… 4s` secara langsung.
- **Statistik balasan** di bawah tiap balasan: model, waktu tempuh, token, dan tok/s.
- **Copy** saat hover untuk setiap balasan; **Retry** saat gagal, yang memulihkan prompt sebelumnya
  *beserta* gambarnya.
- **Pemilih model** yang menampilkan semua model chat terpasang, dengan `📷` untuk model yang punya
  kemampuan vision. Pilihan ini diingat.
- **Vision** — seret gambar ke Arki, tempel, atau gunakan 📎. Maksimal 4 per pesan, 6 MB masing-masing.
- **Toggle 🧠 Deep** — balasan dikirim dengan `think:false` secara default karena model
  beralasan dengan senang hati menghabiskan 230 token untuk berpikir lalu mengembalikan kosong.
  Diukur di mesin ini dengan prompt yang sama: **0.2s / 2 token dibanding 129s / 232 token dan
  balasan kosong.** Nyalakan Deep ketika Anda ingin jawaban yang lebih lambat dan lebih mendalam.
- **Prompt pemula** saat percakapan kosong, dan tombol **↓ latest** saat Anda menggulir ke belakang.
- **New chat** membersihkan transkrip dan memulai baru.
- **Tema terang/gelap**, diingat, mengikuti preferensi OS Anda sebagai nilai awal.
- **Event log** di sidebar — setiap permintaan, pemanggilan tool, kata pemicu, dan error
  lengkap dengan cap waktu.
- Bunyi retro opsional saat status berubah.

---

## Avatar

Arki adalah sebuah *superellipse* yang bernapas, berkedip, mengikuti kursor Anda, merempuh saat
ditekuk, dan berubah warna sesuai kegiatannya. Jenggolan geometris kecil — lima helai membulat dalam
bahasa pil yang sama dengan matanya — bergoyang saat Anda bergerak, dan ratakan saat Arki berubah
menjadi kotak surat untuk menelan berkas, serta berkibar saat pusing. Ketuk untuk komentar, ketuk
tiga kali cepat untuk membuatnya pusing.

<img src="screenshots/avatar.png" width="620" alt="Arki di sidebar, bersama jenggolannya dan status diam">

| Status | Warna | Kapan |
|---|---|---|
| Idle | putih lembut | tidak ada yang terjadi |
| Thinking | ungu | menunggu token pertama |
| Working | biru | sedang streaming balasan |
| Searching | indigo | sedang mencari sesuatu di YouTube |
| Finished | hijau | balasan selesai (bintang-bintang!) |
| Error | merah | Ollama tidak terjangkau atau model gagal |
| Listening | sian | mode hands-free aktif |
| Playing | ungu | sebuah lagu baru saja dimulai |
| Upload / Annoyed / Dizzy | — | sedang melampirkan gambar, ditekuk, ditekuk tiga kali |

---

## Keyboard

| Tombol | Aksi |
|---|---|
| `Enter` | kirim |
| `Shift` + `Enter` | baris baru |
| `Tab` | cincin fokus yang terlihat pada semua kontrol |

Untuk menghentikan balasan di tengah streaming, klik **■ Stop** (tombol Kirim berubah menjadi Stop
saat sedang membuat).

---

## Responsif

Arki terverifikasi dari **320×568 hingga 2560×1440**, termasuk tablet potret, laptop dengan
chrome peramban terbuka, dan ponsel dalam mode lanskap.

| Lebar | Tata letak |
|---|---|
| ≥ 981px | sidebar + percakapan berdampingan |
| 821–980px | sama, sidebar lebih rapat dan Arki lebih kecil |
| ≤ 820px | satu kolom — bar identitas, percakapan, lalu panel-panel; tagline disembunyikan |
| ≤ 560px | mark dan avatar lebih kecil, nama model dipangkas |
| ≤ 400px | kontrol lebih ringkas di seluruh aplikasi |

Tinggi ditangani terpisah, karena jendela yang lebar tetapi pendek adalah masalah yang berbeda:

| Tinggi | Tata letak |
|---|---|
| ≤ 720px (desktop) | Arki lebih kecil, caption disembunyikan |
| ≤ 560px + lanskap | dua kolom ala ponsel dengan rail 168px, header mini, tagline dan notch disembunyikan |
| ponsel (tersusun) | composer menempel di bagian bawah viewport |

Chat mengisi tinggi yang tersisa alih-alih tumbuh mengikuti panjang pesan, sehingga tidak pernah
mendorong composer keluar layar. Sidebar adalah dua sel yang menggulir independen — blok identitas
Arki mempertahankan ukuran penuhnya, sementara player dan kartu tool menggulir di bawahnya,
sehingga membuka lagu tidak akan mendorong Arki keluar bingkai.

Semuanya memakai `dvh` dengan cadangan `vh`, dan composer memberi ruang untuk home indicator
iPhone.

---

## Konfigurasi

| Variabel | Bawaan | Kegunaan |
|---|---|---|
| `PORT` | `5177` | Port HTTP; naik sendiri jika sedang dipakai |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | tempat Ollama mendengarkan |

```bash
PORT=8080 OLLAMA_HOST=http://192.168.1.10:11434 node server.js
```

Arahkan `OLLAMA_HOST` ke mesin lain di LAN Anda untuk memakai GPU-nya sementara halamannya tetap di
mesin Anda. Hanya hubungkan lewat jaringan yang Anda percaya — proxy ini sengaja tidak
menggunakan autentikasi.

---

## Cara kerjanya

```
browser  ──►  server.js  ──►  Ollama  (/api/chat, streaming NDJSON)
   │              │
   │              └──────►  youtube.com  (/api/ytsearch — halaman pencarian → id video)
   │
   └── iframe ──► youtube-nocookie.com / open.spotify.com
```

**`server.js`** berukuran ~150 baris dan mengerjakan empat hal:

1. menyajikan berkas statik dari direktorinya sendiri (dengan perlindungan path-traversal)
2. mem-proxy setiap permintaan `/api/*` ke Ollama, meneruskan streaming NDJSON apa adanya — ini
   ada semata-mata untuk menghindari CORS peramban
3. menyajikan `/api/ytsearch`, yang mengambil halaman pencarian YouTube dan mengekstrak hingga 5
   hasil, di-cache selama 10 menit
4. mendengarkan di `PORT`, naik satu port jika sudah terpakai

**`index.html`** adalah seluruh frontend — mesin avatar di canvas, UI chat, renderer *markdown-lite*,
definisi tool, loop pemanggilan tool, player, dan kata pemicu. Tool dieksekusi di sisi
**klien**; server tidak pernah melihatnya.

**Manajemen konteks:** transkrip dibatasi 40 pesan, di mana 20 terakhir dikirim ke model. Pesan
asisten yang menggantung di awal dipangkas agar pasangan pengguna/asisten tidak pernah terpecah.
Field khusus klien tidak pernah meninggalkan peramban.

---

## Yang diingat

Disimpan di `localStorage`, semuanya berawalan `arki.`:

| Key | Isi |
|---|---|
| `arki.model` | model yang dipilih |
| `arki.think` | 🧠 Deep aktif/nonaktif |
| `arki.theme` | terang / gelap |
| `arki.vol` | volume player |
| `arki.dockVideo` | pratinjau video ditampilkan atau audio-saja |
| `arki.wake` | kata pemicu |

Percakapan itu sendiri **tidak** disimpan. Tidak ada yang ditulis ke disk di mana pun — muat ulang
dan Anda mulai dari nol. Server mencetak dua baris saat mulai dan tidak ada selain itu; ia tidak
pernah mencatat isi permintaan atau pesan.

---

## Pemecahan masalah

**"Can't reach Ollama"** — banner di atas composer berarti server tidak dapat menjangkau Ollama.
Pastikan `ollama serve` sedang berjalan dan `OLLAMA_HOST` cocok dengan lokasi listennya. Aplikasi
otomatis mencoba lagi setiap 5 detik.

**Tidak ada model di dropdown** — `ollama pull qwen3.5:2b` (atau model chat apa pun) untuk
menginstal salah satunya.

**Balasan kosong dari model beralasan** — itu wajar, dan justru alasan kenapa `think:false` adalah
nilai bawaan. Nyalakan **🧠 Deep** lalu tanyakan lagi.

**Balasan pertama sangat lambat** — itu model sedang dimuat ke memori. Beberapa detik untuk model
kecil, hingga ~30s untuk model besar. Timer di bawah balasan menunjukkannya; balasan kedua
langsung terasa.

**Tools tidak pernah terpanggil** — kemungkinan besar model Anda tidak mendukung tool calling. Coba
`granite4.2` atau `gemma4`, atau gunakan saja `/play` dan `/open`.

**🎤 tidak melakukan apa-apa** — Web Speech tidak didukung di peramban Anda (Firefox), atau izin
mikrofon ditolak. Gunakan perintah slash.

**Video tidak mau autoplay** — kebijakan autoplay peramban. Tekan ▶ sekali.

---

## Baik untuk diketahui

- Player YouTube dan Spotify adalah iframe pihak ketiga. Keduanya butuh internet dan menempatkan
  cookie mereka sendiri; prompt Anda tidak pernah dikirim ke mereka.
- Web Speech API mentranskripsi di dalam peramban. Di Chrome itu berarti audio dikirim ke Google
  selama sesi pengenalan berlangsung. Selebihnya — chat, tools, musik — tetap lokal.
- Model lokal kecil bagus dalam *memanggil* tools dan lebih buruk dalam *menahan diri*. Log kartu
  Arki ada supaya Anda selalu bisa melihat persis apa yang terjadi.
- YouTube mungkin mengubah markup halaman hasil pencariannya, yang akan merusak `/api/ytsearch`.
  Jika itu terjadi, `/play` akan jatuh ke membuka halaman pencarian di tab baru alih-alih gagal.

---

## Brand

`logo.svg` adalah mark lengkapnya: gelembung bicara *squircle* berwarna biru yang membawa dua mata
pil Arki dan jenggolan kecilnya — *squircle*-nya **adalah** Arki, gelembungnya **adalah** chat.
Hanya beberapa bentuk dan satu gradien, tanpa fonta dan tanpa dependensi, jadi aman untuk di-*inline*,
diwarnai ulang, atau diskalakan ke ukuran apa pun. Tetap terbaca hingga 16px.

Di dalam aplikasi ia muncul sebagai *lockup* 46px di samping wordmark, berkedip sekali setiap 7.5
detik, dan sekaligus menjadi favicon.

---

## Berkas

```
logo.svg       Mark brand Arki Chat (sekaligus favicon)
server.js      Server statik + proxy streaming Ollama + /api/ytsearch
index.html     Mesin avatar (terinspirasi Coucou), UI chat, tools, player, dan kata pemicu
about.html     Halaman Tentang — apa itu, privasi, kredit, dan lisensi
screenshots/   Gambar-gambar di berkas ini
package.json   Hanya metadata — tidak ada yang perlu diinstal
```

**Halaman Tentang** — `about.html` adalah penjelasan yang ramah manusia: apa itu Arki, panduan
empat langkah, rincian privasi yang jujur, kredit, dan lisensinya. Tertaut dari header dan terbuka
di tab baru sehingga percakapan Anda tidak pernah terputus, serta berbagi key `arki.theme` sehingga
selalu cocok dengan pengaturan terang/gelap chat.

## Kredit

Dibangun dan dipelihara oleh **Adnuri Mohamidi**.

### Avatar

Mesin avatar *squircle* Arki — badan *superellipse*, mata yang diproyeksikan pada bola sphere yang
mengikuti kursor Anda, kedip, pernafasan diam, reaksi poke/annoy/dizzy, serta perubahan bentuk
menjadi kotak saat Anda menjatuhkan berkas — terinspirasi oleh **Mochi**, karakter dari
**[Coucou](https://github.com/Louis-CFM/coucou)** karya Louis Raillé.

Coucou berlisensi MIT, dan mesin Arki adalah reimplementasi JavaScript dari ide-ide tersebut untuk
peramban. Terima kasih kepada Louis telah membuatnya terbuka — "setiap baris kode, setiap animasi,
setiap suara — bebas untuk digunakan, dibaca, di-*fork*, dan di-*remix*."

Selebihnya di Arki Chat — tata letak, sistem tool-calling, player sidebar, kata pemicu, desain
responsif, jenggolan Arki, dan `logo.svg` — adalah karya orisinal proyek ini.

### Berdiri di atas bahu

- [Ollama](https://ollama.com) — menjalankan setiap model secara lokal, dan melakukan penalaran
  yang sebenarnya
- [Fredoka](https://fonts.google.com/specimen/Fredoka) & [Nunito](https://fonts.google.com/specimen/Nunito) — tipografinya
- YouTube dan Spotify — player yang disematkan di sidebar

---

## Lisensi

Arki Chat dirilis di bawah [MIT License](https://opensource.org/licenses/MIT).

Proyek ini memuat karya yang diturunkan dari [Coucou](https://github.com/Louis-CFM/coucou), yang
juga berlisensi MIT. Pemberitahuan aslinya direproduksi di bawah ini sebagaimana diwajibkan
lisensinya:

```
MIT License
Copyright (c) 2026 Louis Raillé

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
