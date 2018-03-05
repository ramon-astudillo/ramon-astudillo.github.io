Ramón Fernandez Astudillo
=========================

\[[Google Scholar](https://scholar.google.pt/citations?user=zJ4uM00AAAAJ&hl=en)\] 
\[[GitHub](https://github.com/ramon-astudillo)\]
\[[LinkedIn](https://www.linkedin.com/in/ramonastudillo/)\]

I am currently Senior Research Scientist at [Unbabel](http://www.unbabel.com/) and associate researcher at [INESC-ID](https://www.l2f.inesc-id.pt/w/Welcome_to_the_Spoken_Language_Systems_Lab) in Lisboa. I got here starting from signal processing, then speech recognition, natural language processing and now machine learning as a whole. I ended up spending very large chunks of my life in Spain, Germany and now Portugal. It is hard to find things that do not interest me, but artificial and crowd intelligence seem particularly motivating in this moment in history. If this does feel short as a description, see below.

### 2016
From 2016 I am Senior Research Scientist at Unbabel, keeping also an affiliation to INESC-ID as associate researcher. I am also co-founder of the Special Interest group for Robust Speech Processing (RoSP-SIG) and organizer of the LxMLS summer schools 2015 till present.

### 2015
Here I researched both robust speech recognition and robust natural language processing speech applications mixing deep learning and latent variable models (need to find time to elaborate on this).

### 2010
I obtained the *Dr-Ing* (PhD) title with distinction in 2010 in the fields of speech processing and robust automatic speech recognition. The thesis had the title *Integration of Short-Time Fourier Domain Speech Enhancement and Observation Uncertainty Techniques for Robust Automatic Speech Recognition* \[[pdf](https://d-nb.info/1005939284/34)\] \[[code](https://github.com/ramon-astudillo/stft_up_tools)\]

My doctor-fathers were Reinhold Orglmeister and Rainer Martin, but I mostly have a doctor-mother, Dorothea Kolossa, who developed the initial idea and helped me kickstart my thesis.

In short, context for my thesis is the following

- Speech enhancement (noise reduction, dereverberation, etc) is done in the STFT domain because of its multiple advantages (source independence, spatio-temporal filtering) 

- ASR happens in feature domains like log-Mel or MFCC, that are non-linear transformations of STFT. Here speech can be represented in a more robust and compact form. 

- It would be ideal to keep your speech enhancement models in STFT domain while doing estimates in e.g. log-Mel domain.

- If we also derived a measure of enhancement uncertainty, there are well established methods to integrate this with ASR models and improve performance.

This was a relatively active topic in robust ASR at the time, with multiple competing approaches (feature/model based). My thesis contributions were basically

- Notice that the Ephraim-Malah filters can be seen as propagating the uncertainty of the posterior distribution associated to a Wiener Filter in STFT domain, through the amplitude and log-amplitude non-linearities \[[IEEE TASLP](http://ieeexplore.ieee.org/abstract/document/6423820/)\].

- Exploiting this fact to transform a complex-Gaussian distributed model of the STFT into MFCC (log-Mel) and RASTA-PLP, deriving first and second order moments \[[Book Chapter](https://pdfs.semanticscholar.org/d32d/72e4dcc59bd014fb9f6428824df035fecaf4.pdf)\].

- Exploiting this fact to derive extensions of super-Gausian prior MMSE estimators based on mixture models \[[IEEE SPL](http://ieeexplore.ieee.org/abstract/document/5504821/)\].

- Showing that this can improve the robustness of ASR systems without retraining, including for performant methods such as the ETSI advanced front-end \[[IEEE STSP](http://ieeexplore.ieee.org/abstract/document/5504821/)\].

Aside from my PhD, in my time in Berlin I also got to tutor the Neural Networks Seminar of EMSP, supervised Phillip Mandelartz's Thesis and helped other students in the department with their projects and theses.

After defending my thesis I still spent some months at EMSP finishing papers. While finishing, a causality led me to discover Isabel Trancoso's department at INESC-ID in Lisbon. After reading João Graças and Diamantino Caseiros papers, I decided to apply for a post-doctoral grant to transition from speech to natural language processing. Luckily, I was awarded with a 3+3 year FCT Post-Doctoral scholarship to join INESC-ID/L2F. 

### 2006
I worked as an intern at Peiker Acustic for six months with the aid of a Leonardo grant and in collaboration with the TU-Berlin. The output was a spectral codebook-based speech reconstruction algorithm. Aside from realising how hard is to write a tech report in German, I also got to know better the Minimum Mean Spectral Amplitude and Log Spectral Amplitude Estimators (also known and Ephraim-Malah filters). 

On this same year I was awarded with a _La Caixa_ and the German Academic Exchange Service (DAAD) scholarship for research towards the Ph.D. degree at the EMSP department of the Technische Universität Berlin. I started working with Dorothea Kolossa on the topic of uncertainty propagation.

### 2005
I got the Industrial Engineering degree with specialization in electronics and automatics at the Escuela Politecnica Superior de Ingenieria de Gijon (Spain). At the time, this was a 6 year multidisciplinary degree plus thesis. I got to learn a lot of math/phisics and all things engineering from industrial heat and cold to macro-economy, got also to play with all levels of programming languages from VHDL and x86 CISC to Visual C++ and MFCs (no Python sadly). On my free time, I started learning fuzzy logic and programmed my first neural network.

I did my last year at Technische Universität Berlin with the aid of an Erasmus grant (2004). My final thesis was also at TU-Berlin, at the Electronics and Medical Signal Processing (EMSP) department (2005). My thesis was directed by Dorothea Kolossa and the topic was prunning in tied-mixture Hidden Markov Models for Automatic Speech Recognition.
