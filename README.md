<div align="center">
  <img src="logo.svg" width="104" alt="Arki Chat">
</div>

# Arki Chat 🟦

Chatbot pendamping berbentuk squircle yang hidup di browser, sekaligus menjadi antarmuka yang lebih ramah untuk [Ollama](https://ollama.com) — menggunakan model lokal yang sama tanpa dashboard developer. Setiap jawaban dibuat secara lokal: tanpa API key, tanpa cloud, tanpa proses build, dan **nol dependensi npm**.

Namun Arki tidak hanya menjawab. Arki juga bisa **bertindak**: mencari YouTube dan memutar lofi melalui pemutar bawaan sambil kamu tetap mengobrol, membuka Gmail atau GitHub di tab untukmu, serta mendengarkan kata pemicu **“Arki”** agar kamu bisa menjeda musik tanpa menyentuh keyboard.

> **Maintainer** — Adnuri Mohamidi

```bash
ollama serve        # 1. Ollama berjalan
node server.js      # 2. Arki (tidak perlu instalasi)
open http://localhost:5177
```

![Arki Chat di desktop, memutar lofi di sidebar sambil mengobrol](screenshots/desktop.png)

<p align="center">
  <img src="screenshots/mobile.png" width="300" alt="Arki Chat di ponsel">
</p>

<p align="center">
  <img src="screenshots/about.png" width="620" alt="Halaman tentang Arki Chat">
</p>

> 🌐 **Bahasa:** [English](README.en.md) · Bahasa Indonesia

---

## Daftar Isi

* [Mulai cepat](#mulai-cepat)
* [Mengapa](#mengapa)
* [Tools — Arki bisa bertindak](#tools--arki-bisa-bertindak)
* [Membuka aplikasi desktop](#membuka-aplikasi-desktop)
* [Memutar musik di halaman](#memutar-musik-di-halaman)
* [Kata pemicu](#kata-pemicu)
* [Slash command](#slash-command)
* [Fitur chat](#fitur-chat)
* [Avatar](#avatar)
* [Keyboard](#keyboard)
* [Responsif](#responsif)
* [Konfigurasi](#konfigurasi)
* [Cara kerjanya](#cara-kerjanya)
* [Apa yang diingat](#apa-yang-diingat)
* [Pemecahan masalah](#pemecahan-masalah)
* [Hal yang perlu diketahui](#hal-yang-perlu-diketahui)
* [Asal nama](#asal-nama)
* [Brand](#brand)
* [File](#file)
* [Kredit](#kredit)
* [Lisensi](#lisensi)

---

## Mulai cepat

**Persyaratan:** Node 18+ (dikembangkan menggunakan Node 24) dan Ollama yang sedang berjalan dengan setidaknya satu model chat.

```bash
# 1. Instal Ollama dan ambil model yang kamu sukai
ollama pull qwen3.5:2b

# 2. Jalankan Arki — tidak perlu npm install, tidak ada dependensi
node server.js

# 3. Buka http://localhost:5177
```

Atau baca [halaman About](about.html) terlebih dahulu jika kamu ingin mengetahui apa yang akan kamu dapatkan.

Jika port 5177 sedang digunakan, Arki akan berpindah secara otomatis ke port kosong berikutnya dan menampilkan URL yang digunakannya.

Tidak ada yang diinstal, dibangun, atau dibundel. `index.html` adalah seluruh frontend; `server.js` adalah server statis sekitar 380 baris, sebuah proxy, sekaligus peluncur aplikasi desktop.

---

## Mengapa

Ollama adalah salah satu cara paling mudah untuk menjalankan model di komputer sendiri, dan perlahan menjadi otak lokal bawaan bagi banyak orang. Namun antarmuka web-nya tidak pernah benar-benar dibuat untuk *menggunakan* model — melainkan untuk *memeriksa* model. Parameter model, jumlah token, konsep berbentuk curl. Antarmuka tersebut sangat baik untuk menjawab pertanyaan “apakah model saya berjalan?”, tetapi kurang menjawab “sebenarnya saya ingin melakukan apa?”.

Arki Chat adalah pintu masuk alternatif. Model sama, komputer sama, privasi sama — tetapi dalam bentuk pendamping, bukan dashboard:

* **Siapa pun bisa memulai.** `ollama serve`, `node server.js`, selesai. Tidak perlu Docker, Python, mengunduh weights, atau file konfigurasi.
* **Tidak perlu memahami istilah teknis.** Kamu tidak memilih model berdasarkan jumlah parameter; cukup pilih model yang bekerja, dan Arki akan memberi tahu model mana yang dapat melihat gambar.
* **Arki melakukan sesuatu, bukan hanya menjawab.** Minta lofi dan Arki akan memutarnya sambil kamu terus mengobrol. Minta Gmail dan Arki akan membukanya.
* **Arki memberi tahu apa yang sebenarnya terjadi.** Setiap jawaban menyertakan model, waktu proses, dan kecepatan token. Setiap pemanggilan tool menunjukkan secara tepat apa yang dilakukan. Model lokal kecil memang tidak sempurna; Arki tidak menyembunyikannya.
* **Arki menyesuaikan diri.** Lebar 320px maupun 2560px — aplikasi tetap sama, dan versi ponselnya benar-benar merupakan versi utama.

Bagi siapa pun yang sudah nyaman bekerja di terminal, antarmuka Ollama sendiri tetap merupakan pilihan yang tepat. Arki ditujukan untuk orang yang sudah menjalankan Ollama tetapi belum yakin harus melakukan apa selanjutnya.

---

## Tools — Arki bisa bertindak

Empat tool terhubung ke setiap request. Ketika model memutuskan bahwa salah satunya diperlukan, model mengeluarkan entri `tool_calls`, Arki menjalankannya secara lokal, kemudian hasil sebenarnya diberikan kembali agar model dapat mengonfirmasi apa yang benar-benar terjadi.

| Tool            | Parameter           | Fungsinya                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `play_music`    | `query`, `service?` | Mencari YouTube dan memutar hasil teratas di pemutar sidebar. Juga menerima URL YouTube, link atau URI track/album/playlist Spotify, maupun URL file audio langsung.                                                                                                                                                                                 |
| `control_music` | `action`            | `pause` · `resume` · `stop` · `next` pada pemutar sidebar.                                                                                                                                                                                                                                                                                           |
| `set_volume`    | `level`             | Mengatur volume di dalam halaman, 0–100.                                                                                                                                                                                                                                                                                                             || `open_app` | `name` | Membuka situs di tab baru — gmail, youtube, github, drive, calendar, maps, netflix, reddit, wikipedia, x, notion, figma, amazon, chatgpt, claude, weather, news, npm, huggingface, dan lainnya, melalui 41 shortcut nama yang mencakup sekitar 37 situs. URL lengkap juga dapat digunakan; nama yang tidak dikenali akan dialihkan ke pencarian web. **Tool ini juga meluncurkan program desktop terpasang apa pun, berdasarkan nama** — di mesin tempat Arki berjalan. |

**Ke mana hasilnya ditampilkan.** Pemanggilan tool ditampilkan sebagai kartu di sidebar pada bagian *Tool activity* — termasuk argumen dan hasil aktual — dengan maksimum 8 aktivitas terakhir serta tombol **clear**. Transkrip percakapan tetap bersih; Arki hanya mengatakan apa yang dilakukannya dalam satu kalimat.

```text
kamu    ▸ Putarkan musik piano jazz yang tenang untuk saya
arki    ▸ Silakan — piano jazz yang lembut sedang diputar di sidebar.
          ⚡ play_music  query="calm jazz piano"
            Sekarang diputar di YouTube: “4K Cozy Coffee Shop with Smooth Piano
            Jazz Music…” oleh Relaxing Jazz Piano (3 jam, 35 menit).
```

**Detail yang perlu diketahui**

* Loop berjalan hingga **4 giliran** untuk setiap pesan, sehingga Arki dapat merangkai beberapa tindakan (memutar, lalu mengatur volume, lalu mengonfirmasi).
* Jika model menolak array `tools`, Arki mencatatnya lalu mencoba kembali giliran tersebut **tanpa tools**, alih-alih gagal. Chat tidak akan rusak karenanya.
* **6** tindakan terakhir dirangkum ke dalam system message, sehingga permintaan lanjutan seperti *“putar yang berikutnya”* atau *“kecilkan volumenya”* tetap dapat bekerja.
* Model lokal kecil sangat bersemangat membantu — model 2B mungkin memanggil `set_volume` sendiri. Deskripsi tool dan system prompt sama-sama secara eksplisit melarangnya, tetapi jika model mengabaikannya, kartu di sidebar akan menunjukkan secara tepat apa yang dilakukan.

**Pemanggilan tool membutuhkan model yang mendukung tool.** Telah diverifikasi bekerja dengan `qwen3.5:2b`, `granite4.2`, `gemma4`, `ornith-1.5:9b`, dan `Spark-X2.5-4B`. `phi4-mini` dan `gemma2:9b` mengabaikan tools dan hanya mengobrol — dengan model tersebut semuanya tetap dapat digunakan melalui slash command.

---

## Membuka aplikasi desktop

Halaman web tidak pernah bisa menjalankan program desktop — itu batasan semua aplikasi web, bukan khusus Arki. Jadi peluncurannya dilakukan oleh server:

| Endpoint | Fungsinya |
|---|---|
| `GET /api/apps` | shortcut terkurasi yang dikenal mesin ini; halaman membangun deskripsi tool `open_app` dari sana |
| `POST /api/launch` | body `{ "name": "vlc" }` → mencocokkan nama lalu menjalankan programnya |

**Nama apa pun bisa — LibreOffice, VLC, dan VS Code hanyalah contoh.** Sebuah nama ditempuh dengan urutan ini:

1. **Tabel terkurasi** di `server.js` — perintah terverifikasi per OS plus alias yang bersahabat (`vscode`, `vs code`, `code` → VS Code; `soffice` → LibreOffice). Terkurasi dulu, supaya `code` membuka VS Code dan bukan codepen.io.
2. **Situs yang dikenal** — `gmail`, `github`, dan `codepen` tetap membuka tab, seperti sebelumnya.
3. **Operating system-nya sendiri**, untuk apa pun selain itu — lihat tabel di bawah.
4. **Pencarian DuckDuckGo**, jika tidak ada yang terbuka, supaya kata yang tak dikenal tetap berguna.

`/open` menempuh urutan yang sama persis, tanpa melibatkan model.

| OS | Bagaimana OS mencocokkan nama yang tidak dikenal |
|---|---|
| macOS | `open -a "<nama>"` — LaunchServices, sehingga aplikasi terpasang apa pun bisa |
| Linux | `Name=`/`Exec=` dari file `.desktop` yang cocok, selain itu nama sebagai binary di `PATH` |
| Windows | `cmd /c start "<nama>"` — App Paths / Start Menu |

**Tidak ada yang lewat shell.** Setiap percobaan adalah array argv tetap yang diberikan ke `spawn()`, dan nama itu sendiri harus berupa huruf, angka, spasi, dan `.'+_ -` — tanpa pemisah path, tanpa tanda hubung di awal, dan tanpa karakter apa pun yang bisa dibaca `cmd.exe` sebagai sintaks — sehingga sebuah request tetap tidak bisa menyelipkan string perintah sembarang. Path Windows yang tidak terpasang dibuang sebelum percobaan pertama, sehingga instalasi sebagian tetap berfungsi.

**Ketika gagal, kamu tahu alasannya.** `Could not launch VLC — Unable to find application named 'VLC'` sampai ke kartu tool, model mengulanginya, dan chat tetap berjalan. Kata yang tak dikenal justru dialihkan ke pencarian web: *Could not launch “zzz” — …, so I searched the web for it instead.* Slash command melakukan hal yang sama tanpa melibatkan model: `/open vscode`.

**Program dijalankan pada mesin tempat `node server.js` berjalan**, yang belum tentu mesin tempat browser berada — perlu diingat jika kamu menyajikan Arki ke ponsel. Server ini secara desain tidak terautentikasi, sehingga apa pun yang bisa menjangkau port-nya bisa memintanya membuka aplikasi yang terpasang; sajikan hanya di jaringan yang kamu percaya.

**Menambahkan aplikasi bersifat opsional.** Entri `LOCAL_APPS` di `server.js` (`id`, `label`, `aliases`, `cmds` per platform) hanya layak ditulis untuk alias yang lebih bersahabat atau nama yang tidak dikenali sendiri oleh OS — Linux mengirim binary `libreoffice` sementara nama tampilannya "LibreOffice". Semuanya yang lain tanpa entri tetap berfungsi.

---

## Memutar musik di halaman

Pemutar berada di **sidebar**, tepat di bawah avatar, sehingga musik tidak pernah mengganggu kolom percakapan.

```text
❚❚ ■ ▾   4K Cozy Coffee Shop with Smooth Piano Jazz Music for Relaxing…
         YouTube · pemutar dalam halaman
         ┌────────────────┐
         │   video 16:9   │
         └────────────────┘
         ────────●────  ↗  ✕
```

* ❚❚ / ▶ menjeda dan melanjutkan · ■ berhenti · ▾ menyembunyikan video tetapi **tetap memutar audio** (diingat antar-sesi) · slider volume · ↗ membuka sumber di tab · ✕ menutup
* Sidebar terdiri dari dua sel yang dapat di-scroll secara independen: Arki tetap pada ukuran penuh 290px dan pemutar melakukan scroll di bawahnya, sehingga memulai track tidak akan pernah mendorong Arki keluar dari frame.
* Avatar mendapatkan cahaya violet *Playing* setiap kali sebuah track dimulai.

**Dari mana audio berasal**

* **YouTube** — tidak memerlukan API key. YouTube telah menghentikan embed publik untuk fitur “search”, sehingga `server.js` menyediakan `/api/ytsearch`: fitur ini membaca halaman hasil pencarian normal sekali, mengambil ID video nyata beserta judul, channel, dan durasinya, lalu halaman melakukan embed terhadap hasil teratas menggunakan pemutar `youtube-nocookie`. Hasil disimpan di cache selama 10 menit.
* **Spotify** — link track, album, playlist, show, dan episode serta URI `spotify:` langsung di-embed ke halaman. Spotify tidak menyediakan *search* yang dapat di-embed, sehingga pencarian biasa (atau `service: "spotify"`) membuka `open.spotify.com/search/…` di tab baru dan Arki meminta kamu menempelkan link sebenarnya kembali untuk pemutaran di halaman.
* **File audio apa pun** — URL yang berakhiran `.mp3`, `.m4a`, `.aac`, `.ogg`, `.wav`, `.flac`, `.opus`, atau `.mp4` diputar melalui elemen `<audio>` native, yang kemudian dapat dijeda, dilewati, dan diatur volumenya oleh Arki seperti sumber lainnya.

> Browser memblokir autoplay tanpa suara sampai menganggap kamu sebagai pendengar yang aktif. Jika video tidak mulai sendiri, tekan ▶ sekali (atau klik di dalam pemutar) dan pemutar akan tetap berjalan.

---

## Kata pemicu

Klik **🎤 Wake “Arki”** untuk mulai mendengarkan (Chrome atau Safari, dan izin mikrofon akan diminta satu kali).

| Kamu mengatakan               | Arki melakukan                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- |
| *“Arki”*                      | menjeda musik — ucapkan lagi untuk melanjutkan                                   |
| *“Arki, putarkan bossa nova”* | menganggap bagian setelahnya sebagai permintaan dan menjalankannya melalui tools |
| *“Arki, pause that”*          | `"pause that"` dikenali sebagai slash command dan langsung dijalankan            |

Saat mendengarkan, Arki berubah menjadi cyan dengan status *Listening* dan menampilkan transkrip secara langsung sehingga kamu dapat melihat apa yang didengarnya. Klik `wake word: Arki` di bawah avatar untuk mengganti kata pemicu — bisa dengan kata apa pun, yang dicocokkan sebagai satu kata utuh.

Pengenalan suara menggunakan Web Speech API yang **disediakan oleh browser** (di Chrome, audio dikirim ke Google untuk transkripsi) dan hanya tersedia di Chromium dan Safari. Firefox dan browser lainnya akan mendapatkan pesan yang jelas di event log dan tombol akan otomatis dinonaktifkan. Slash command di bawah menyediakan fungsi yang sama tanpa mikrofon.

---

## Slash command

Perintah ini melewati model sepenuhnya dan langsung menjalankan tool — berguna untuk pengujian, browser tanpa dukungan speech, dan ketika kamu hanya ingin sesuatu berhenti.

| Command                    | Contoh                     |
| -------------------------- | -------------------------- |
| `/play <query>`            | `/play lofi hip hop beats` |
| `/pause` `/resume` `/stop` | `/pause`                   |
| `/next` atau `/skip`       | `/next`                    |
| `/vol <0-100>`             | `/vol 35`                  |
| `/open <app atau url>`     | `/open gmail`              |

---

## Fitur chat

* **Streaming reply** token demi token, dengan tombol **Stop** yang berfungsi serta timer langsung `thinking… 3s` / `writing… 4s`.
* **Statistik jawaban** di bawah setiap jawaban: model, waktu proses, jumlah token, dan tok/s.
* **Copy** saat hover untuk setiap jawaban; **Retry** jika terjadi kegagalan, yang mengembalikan prompt sebelumnya *beserta* gambarnya.
* **Pemilih model** yang menampilkan setiap model chat yang terinstal, dengan `📷` sebagai penanda model yang mendukung vision. Pilihan model akan diingat.
* **Vision** — seret gambar ke Arki, paste gambar, atau gunakan 📎. Maksimum 4 gambar per pesan, masing-masing 6 MB.
* **🧠 Deep toggle** — jawaban dikirim dengan `think:false` secara default karena model reasoning dapat menghabiskan 230 token untuk berpikir lalu tidak mengembalikan apa pun. Diukur pada mesin ini dengan prompt yang sama: **0,2 detik / 2 token dibandingkan 129 detik / 232 token dan jawaban kosong.** Aktifkan Deep ketika kamu menginginkan jawaban yang lebih lambat dan mendalam.
* **Starter prompt** pada percakapan kosong, serta tombol **↓ latest** ketika kamu sedang menggulir ke belakang.
* **New chat** menghapus transkrip dan memulai percakapan baru.
* **Tema terang/gelap**, disimpan dan secara default mengikuti preferensi OS.
* **Event log** di sidebar — setiap request, pemanggilan tool, wake word, dan error dengan timestamp.
* Bunyi retro opsional saat terjadi perubahan status.

---

## Avatar

Arki adalah superellipse yang bernapas, berkedip, mengikuti kursor, mengempis ketika disentuh, dan berubah warna sesuai aktivitasnya. Sebuah poni geometris kecil — lima untaian membulat dengan bahasa bentuk yang sama seperti mata — bergerak mengikuti gerakanmu, menjadi rata ketika Arki berubah menjadi kotak untuk menelan file, dan bergerak liar ketika pusing. Ketuk avatar untuk mendapatkan komentar singkat; ketuk tiga kali dengan cepat untuk membuatnya pusing.

<img src="screenshots/avatar.png" width="620" alt="Arki di sidebar, dengan poninya dan kondisi idle">

| Status                   | Warna        | Kapan                                                       |
| ------------------------ | ------------ | ----------------------------------------------------------- |
| Idle                     | putih lembut | tidak ada aktivitas                                         |
| Thinking                 | violet       | menunggu token pertama                                      |
| Working                  | biru         | sedang melakukan streaming jawaban                          |
| Searching                | indigo       | sedang mencari sesuatu di YouTube                           |
| Finished                 | hijau        | jawaban selesai (dengan bintang!)                           |
| Error                    | merah        | Ollama tidak dapat dijangkau atau model mengalami kegagalan |
| Listening                | cyan         | mode hands-free aktif                                       |
| Playing                  | violet       | sebuah track baru saja dimulai                              |
| Upload / Annoyed / Dizzy | —            | melampirkan gambar, disentuh, diketuk tiga kali             |

---

## Keyboard

| Tombol            | Fungsi                                     |
| ----------------- | ------------------------------------------ |
| `Enter`           | mengirim                                   |
| `Shift` + `Enter` | baris baru                                 |
| `Tab`             | menampilkan focus ring pada setiap kontrol |

Untuk menghentikan jawaban di tengah streaming, klik **■ Stop** (tombol Send berubah menjadi Stop selama proses pembuatan jawaban).

---

## Responsif

Arki telah diverifikasi dari ukuran **320×568 hingga 2560×1440**, termasuk tablet dalam orientasi portrait, laptop dengan browser chrome terbuka, dan ponsel dalam orientasi landscape.

| Lebar     | Layout                                                                   |
| --------- | ------------------------------------------------------------------------ |
| ≥ 981px   | sidebar + percakapan berdampingan                                        |
| 821–980px | sama, tetapi sidebar lebih sempit dan Arki lebih kecil                   |
| ≤ 820px   | satu kolom — identity bar, percakapan, lalu panel; tagline disembunyikan |
| ≤ 560px   | mark dan avatar lebih kecil, nama model dipangkas                        |
| ≤ 400px   | kontrol dibuat ringkas di seluruh aplikasi                               |

Tinggi layar ditangani secara terpisah karena jendela yang lebar tetapi pendek merupakan masalah yang berbeda:

| Tinggi              | Layout                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| ≤ 720px (desktop)   | Arki lebih kecil, caption disembunyikan                                                  |
| ≤ 560px + landscape | dua kolom seperti ponsel dengan rail 168px, header mini, tagline dan notch disembunyikan |
| ponsel (stacked)    | composer tetap menempel di bagian bawah viewport                                         |

Chat mengisi ruang yang tersedia, bukan memperbesar diri mengikuti jumlah pesan, sehingga composer tidak pernah terdorong keluar layar. Sidebar memiliki dua sel yang dapat di-scroll secara independen — blok identitas Arki mempertahankan ukuran penuh, sementara player dan kartu tool melakukan scroll di bawahnya. Dengan demikian, membuka sebuah track tidak akan pernah mendorong Arki keluar dari frame.

Semuanya menggunakan `dvh` dengan fallback `vh`, dan composer memberikan padding untuk home indicator iPhone.

---

## Konfigurasi

| Variabel      | Default                  | Fungsi                                         |
| ------------- | ------------------------ | ---------------------------------------------- |
| `PORT`        | `5177`                   | port HTTP; otomatis naik jika sedang digunakan |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | lokasi Ollama berjalan                         |

```bash
PORT=8080 OLLAMA_HOST=http://192.168.1.10:11434 node server.js
```

Arahkan `OLLAMA_HOST` ke komputer lain di LAN untuk menggunakan GPU komputer tersebut sementara halaman tetap berada di komputer kamu. Hanya lakukan ini melalui jaringan yang kamu percaya — proxy sengaja tidak menggunakan autentikasi.

---

## Cara kerjanya

```text
browser  ──►  server.js  ──►  Ollama  (/api/chat, streaming NDJSON)
   │              │
   │              └──────►  youtube.com  (/api/ytsearch — halaman pencarian → video ids)
   │
   └── iframe ──► youtube-nocookie.com / open.spotify.com
```

**`server.js`** berisi sekitar 380 baris dan melakukan lima hal:

1. menyajikan file statis dari direktorinya sendiri (dengan perlindungan terhadap path traversal)
2. melakukan proxy terhadap setiap request `/api/*` ke Ollama, melakukan streaming NDJSON secara langsung — ini hanya diperlukan untuk menghindari CORS browser
3. menyediakan `/api/ytsearch`, yang mengambil halaman pencarian YouTube dan mengekstrak hingga 5 hasil, dengan cache selama 10 menit
4. mendengarkan pada `PORT`, menaikkan port satu per satu jika port tersebut sedang digunakan
5. menjawab `GET /api/apps` dan `POST /api/launch` — mencocokkan nama aplikasi apa pun sesuai OS lalu menjalankannya, lihat [Membuka aplikasi desktop](#membuka-aplikasi-desktop)

**`index.html`** adalah seluruh frontend — engine avatar pada canvas, UI chat, renderer markdown-lite, definisi tool, loop pemanggilan tool, player, dan wake word. Tools dijalankan **di sisi client**; server tidak pernah melihatnya.

**Manajemen konteks:** transkrip dibatasi hingga 40 pesan, dan 20 pesan terakhir dikirim ke model. Pesan assistant yang terpisah di awal akan dipangkas agar pasangan user/assistant tidak pernah terbelah. Field yang hanya digunakan oleh client tidak pernah meninggalkan browser.

---

## Apa yang diingat

Disimpan di `localStorage`, semuanya menggunakan prefix `arki.`:

| Key              | Isi                                       |
| ---------------- | ----------------------------------------- |
| `arki.model`     | model yang dipilih                        |
| `arki.think`     | Deep aktif/nonaktif                       |
| `arki.theme`     | light / dark                              |
| `arki.vol`       | volume player                             |
| `arki.dockVideo` | preview video ditampilkan atau audio-only |
| `arki.wake`      | kata pemicu                               |

Percakapan itu sendiri **tidak disimpan secara permanen**. Tidak ada apa pun yang ditulis ke disk — setelah reload kamu akan memulai dari awal. Server hanya mencetak dua baris saat startup dan tidak melakukan hal lainnya; server tidak pernah mencatat isi request atau pesan.

---

## Pemecahan masalah

**“Can't reach Ollama”** — banner di atas composer berarti server tidak dapat terhubung ke Ollama. Pastikan `ollama serve` sedang berjalan dan `OLLAMA_HOST` sesuai dengan lokasi Ollama benar-benar mendengarkan. Aplikasi akan mencoba kembali setiap 5 detik secara otomatis.

**Tidak ada model di dropdown** — jalankan `ollama pull qwen3.5:2b` (atau model chat apa pun) untuk memasang model.

**Jawaban kosong dari model reasoning** — ini memang dapat terjadi, dan merupakan alasan `think:false` menjadi default. Aktifkan **🧠 Deep** lalu coba lagi.

**Jawaban pertama sangat lambat** — model sedang dimuat ke memori. Model kecil membutuhkan beberapa detik, sedangkan model besar dapat membutuhkan hingga sekitar 30 detik. Timer di bawah jawaban menunjukkan proses tersebut; jawaban kedua akan langsung muncul.

**Tools tidak pernah berjalan** — kemungkinan model kamu tidak mendukung tool calling. Coba `granite4.2` atau `gemma4`, atau gunakan `/play` dan `/open`.

**🎤 tidak melakukan apa-apa** — Web Speech tidak didukung browser kamu (Firefox), atau izin mikrofon ditolak. Gunakan slash command.

**Video tidak melakukan autoplay** — ini disebabkan kebijakan autoplay browser. Tekan ▶ sekali.

---

## Hal yang perlu diketahui

* Player YouTube dan Spotify merupakan iframe pihak ketiga. Keduanya membutuhkan internet dan menggunakan cookie mereka sendiri; prompt kamu tidak pernah dikirim kepada mereka.
* Web Speech API melakukan transkripsi di browser. Di Chrome, ini berarti audio dikirim ke Google selama sesi pengenalan berlangsung. Selain itu — chat, tools, dan musik — tetap lokal.
* Model lokal kecil bagus dalam *memanggil* tools tetapi kurang bagus dalam *menahan diri*. Log kartu Arki tersedia agar kamu selalu dapat melihat secara tepat apa yang terjadi.
* YouTube dapat mengubah markup halaman hasil pencarian, yang dapat menyebabkan `/api/ytsearch` rusak. Jika hal tersebut terjadi, `/play` akan beralih membuka halaman pencarian di tab baru daripada gagal.
* Meluncurkan aplikasi desktop menjalankan satu perintah tetap yang divalidasi di mesin yang menjalankan `server.js`. Sebuah nama harus berupa huruf, angka, spasi, dan `.'+_ -`, dan tidak ada yang pernah lewat shell, sehingga sebuah request tidak bisa mengeksekusi string perintah sembarang.

---

## Asal nama

**Arki** adalah gabungan nama anak saya: **Arvin** dan **Wiki**— dua nama, satu pendamping yang hidup di browser, dan satu kata pemicu yang mudah diucapkan.

---

## Brand

`logo.svg` adalah keseluruhan identitas visual: speech bubble biru berbentuk squircle yang membawa dua mata berbentuk pill milik Arki dan poni kecilnya — squircle *adalah* Arki, bubble *adalah* chat. Hanya menggunakan beberapa bentuk dan satu gradient, tanpa font dan tanpa dependensi, sehingga aman untuk di-inline, diberi warna ulang, atau diperbesar maupun diperkecil ke ukuran apa pun. Tetap mudah dibaca hingga ukuran 16px.

Di dalam aplikasi, logo muncul sebagai lockup 46px di samping wordmark, berkedip sekali setiap 7,5 detik, dan juga berfungsi sebagai favicon.

---

## File

```text
logo.svg       Identitas visual Arki Chat (juga favicon)
server.js      Static server + proxy streaming Ollama + /api/ytsearch + peluncur aplikasi desktop
index.html     Avatar engine (terinspirasi Coucou), UI chat, tools, player dan wake word
about.html     Halaman About — apa itu Arki, privasi, kredit dan lisensi
screenshots/   Gambar yang digunakan dalam file ini
package.json   Hanya metadata — tidak ada yang perlu diinstal
```

**Halaman About** — `about.html` adalah penjelasan yang ditujukan untuk manusia: apa itu Arki, quickstart empat langkah, penjelasan privasi secara jujur, kredit, dan lisensi. Halaman ini ditautkan dari header dan dibuka di tab baru agar percakapan tidak pernah terganggu. Halaman ini juga berbagi key `arki.theme`, sehingga selalu mengikuti pengaturan tema terang/gelap pada chat.

---

## Kredit

Dibuat dan dipelihara oleh **Adnuri Mohamidi**.

### Avatar

Engine avatar squircle Arki — tubuh superellipse, mata yang diproyeksikan pada bola dan mengikuti kursor, kedipan, napas saat idle, reaksi ketika disentuh/diganggu/pusing, serta perubahan bentuk menjadi kotak ketika file dijatuhkan — terinspirasi oleh **Mochi**, karakter dari **[Coucou](https://github.com/Louis-CFM/coucou)** karya Louis Raillé.

Coucou menggunakan lisensi MIT, dan engine Arki merupakan implementasi ulang JavaScript dari ide-ide tersebut untuk browser. Terima kasih kepada Louis karena telah membuatnya terbuka — “setiap baris kode, setiap animasi, setiap suara — bebas digunakan, dibaca, di-fork, dan di-remix.”

Semua hal lainnya dalam Arki Chat — layout, sistem tool-calling, player sidebar, wake word, desain responsif, poni Arki, dan `logo.svg` — merupakan karya asli proyek ini.

### Juga menggunakan

* [Ollama](https://ollama.com) — menjalankan setiap model secara lokal dan melakukan proses reasoning sebenarnya
* [Fredoka](https://fonts.google.com/specimen/Fredoka) & [Nunito](https://fonts.google.com/specimen/Nunito) — font
* YouTube dan Spotify — player yang di-embed di sidebar

---

## Lisensi

Arki Chat dirilis berdasarkan [MIT License](https://opensource.org/licenses/MIT).

Proyek ini mencakup karya yang berasal dari [Coucou](https://github.com/Louis-CFM/coucou), yang juga menggunakan lisensi MIT. Pemberitahuan asli direproduksi di bawah ini karena diwajibkan oleh lisensinya:

```text
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

