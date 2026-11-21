# Forensik·AI — Deteksi Keaslian Gambar

Website untuk memeriksa apakah sebuah gambar kemungkinan **dibuat oleh AI** atau **foto asli**.
Semua analisis berjalan di browser — gambar tidak diunggah ke server mana pun.

## Metode analisis

| Analisis | Yang diperiksa |
|---|---|
| **Metadata** | Jejak generator AI (Stable Diffusion/ComfyUI, Midjourney, DALL·E/ChatGPT, Adobe Firefly, Gemini/Imagen, FLUX, dll.), penanda IPTC `trainedAlgorithmicMedia`, Content Credentials (C2PA), dan EXIF kamera |
| **ELA** (Error Level Analysis) | Area yang diedit/ditempel; kualitas & penguatan dapat diatur |
| **Noise residual** | Noise sensor kamera vs. permukaan "terlalu halus" khas gambar AI |
| **Spektrum FFT** | Puncak periodik akibat upsampling pada model AI |
| **Jejak sensor (CFA)** | Pola interpolasi Bayer/demosaicing dari sensor kamera asli — tidak dimiliki gambar sintetis |
| **Watermark tak terlihat** | Dekode watermark `invisible-watermark` (dwtDct) bawaan Stable Diffusion v1/v2 & SDXL |
| **Kompresi JPEG ganda** | Periodisitas histogram koefisien DCT — menandakan JPEG pernah disimpan ulang |
| **Detektor model AI (ML)** | Jaringan saraf ViT [Community Forensics frontier](https://huggingface.co/Thermostatic/community-forensics-frontier-detector-2026-08) (MIT, 44 MB) via onnxruntime-web — bekerja meski metadata sudah dihapus (mis. gambar WhatsApp). Model diunduh sekali lalu disimpan di cache browser |
| **Grafik sinyal** | Histogram warna RGB/luminans, profil spektrum radial, histogram koefisien DCT (interaktif) |

Hasil digabung menjadi persentase indikasi AI, daftar indikator beserta alasannya,
informasi file (termasuk SHA-256), dan laporan `.txt` yang bisa diunduh.

## Menjalankan

Buka `index.html` langsung di browser, atau jalankan server lokal:

```bash
python -m http.server 8765
```

lalu buka http://localhost:8765.

## Keterbatasan

Tidak ada metode yang 100% akurat. Metadata dapat dihapus atau dipalsukan, dan kompresi
media sosial (WhatsApp, Instagram, dll.) menghilangkan banyak jejak forensik.
Gunakan hasilnya sebagai indikasi, bukan bukti mutlak.
