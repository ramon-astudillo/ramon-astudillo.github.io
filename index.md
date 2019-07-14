Ramón Fernandez Astudillo
=========================

\[[Google Scholar](https://scholar.google.pt/citations?user=zJ4uM00AAAAJ&hl=en)\] 
\[[GitHub](https://github.com/ramon-astudillo)\]
\[[LinkedIn](https://www.linkedin.com/in/ramonastudillo/)\]
\[[Twitter](https://twitter.com/RamonAstudill12)\]

I am currently Research Staff Member at IBM Research AI in the [T. J. Watson research center in Yorktown Heights](https://www.research.ibm.com/labs/watson/visitor.shtml), New York. Before this I  was senior Research Scientist at [Unbabel](http://www.unbabel.com/) and associate researcher at [INESC-ID](https://www.l2f.inesc-id.pt/w/Welcome_to_the_Spoken_Language_Systems_Lab) in Lisboa and PhD candidate at [TU Berlin](https://www.emsp.tu-berlin.de/menue/startseite/). I got here starting from signal processing, then speech recognition and then natural language processing. While at it, deep learning happened. I ended up spending very large chunks of my life in Spain, Germany and Portugal and recently moved to the Unites States. It is hard to find things that do not interest me, but artificial and crowd intelligence seem particularly motivating in this moment in history. If this does feel short as a description, see below.

### 2019

- Follow up work from JSALT2018 workshop got __shortlisted for best student paper__ award at Interspeech 2019!. This follows cycle-GANs in image or Dual Learning in MT but applied to end-to-end ASR \[[preprint](https://arxiv.org/abs/1905.01152)\]

- __Joined IBM research AI__ in NY! Will be Research Staff Member at the Multilingual Natural Language Processing (MNLP) group in the [T. J. Watson research center in Yorktown Heights](https://www.research.ibm.com/labs/watson/visitor.shtml).

- After 9 great years as Research Associate at the [Spoken Language Systems lab at INESC-ID](https://www.l2f.inesc-id.pt/w/Welcome_to_the_Spoken_Language_Systems_Lab) in Lisbon I have to (reluctantly!) __leave INESC-ID__ to move to my next step. I leave great friends from which I have learned a lot, an amazing infrastracture and fun memories.

### 2018

- Talked at some company in Berlin about the current state of Quality Estimation for Machine Translation (some details about our WMT 2018 work) \[[slides](https://www.dropbox.com/s/js44ga3ulwbdsie/nqe.pdf?dl=0)\]

- Everybody should do JSALT a least once in life. Joined Takaaki Hori and Shinji Watanabe's team as senior member for the [5th Jelinek Summer Workshop (JSALT2018)](https://www.clsp.jhu.edu/workshops/18-workshop/multilingual-end-end-asr-incomplete-data/) at Johns Hopkins University. Investigated cicle-consistency losses to learn from unpaired text and speech.

- After 2.5 years, its time to leave [Unbabel](http://www.unbabel.com/). What a ride. From 28 employess to 130, funding rounds A and B and a concentrated dose of the start-up life. A privilige to have been in a start-up that hires such amazing talent. 

- Talked at university of Hildeberg about the impact of deep learning in Spoken Language Translation (mostly about my separate knowlegde of ASR and MT) \[[slides](https://www.dropbox.com/s/dira36wh9dmnill/nslt.pdf?dl=0)\]

- Co-created this years word and document-level Quality Estimation (QE) WMT tasks [WMT2018 paper](https://www.aclweb.org/anthology/W18-6451)\]. Corpus builder for word-level QE with optional adequacy task (thought for NMT) \[[code](https://github.com/ramon-astudillo/word-level-qe-corpus-builder)

### 2015

- Was visiting scholar at the Language Technologies institute in Carnegie Melon University with the allways inspiring Bhiksha Raj. 

### 2012

- Held a tutorial on Uncertainty Handling for Robust Speech Recognition with Li Deng and Emmanuel Vincent \[[tutorial Interspeech 2012](https://homepages.loria.fr/evincent/talks/tutorialIS12.pdf)\]

### 2010

- Joined the [Spoken Language Systems lab at INESC-ID](https://www.l2f.inesc-id.pt/w/Welcome_to_the_Spoken_Language_Systems_Lab) with and FCT grant. Looking forward to keep my work on uncertainty and learning about natural language processing

#### Phd

Obtained the Dr-Ing (PhD) title with distinction in 2010 in the fields of speech processing and robust automatic speech recognition. The thesis had the title **Integration of Short-Time Fourier Domain Speech Enhancement and Observation Uncertainty Techniques for Robust Automatic Speech Recognition**
\[[pdf](https://d-nb.info/1005939284/34)\] \[[code](https://github.com/ramon-astudillo/stft_up_tools)\]

My doctor-fathers were Reinhold Orglmeister and Rainer Martin, but I mostly have a doctor-mother, Dorothea Kolossa, who developed the initial idea and helped me kickstart my thesis.

In short, context for my thesis is the following

- Speech enhancement (noise reduction, dereverberation, etc) is done in the STFT domain because of its multiple advantages (source independence, spatio-temporal filtering) 

- ASR happens in feature domains like log-Mel or MFCC, that are non-linear transformations of STFT. Here speech can be represented in a more robust and compact form. 

- It would be ideal to keep your speech enhancement models in STFT domain while doing estimates in e.g. log-Mel domain.

- If we also derived a measure of enhancement uncertainty, there are well established methods to integrate this with ASR models and improve performance.

This was a relatively active topic in robust ASR at the time, with multiple competing approaches (feature/model based). My thesis contributions were basically

- Notice that the Ephraim-Malah filters can be seen as propagating the uncertainty of the posterior distribution associated to a Wiener Filter in STFT domain, through the amplitude and log-amplitude non-linearities \[[IEEE TASLP article](http://ieeexplore.ieee.org/abstract/document/6423820/)\].

- Exploiting this fact to transform a complex-Gaussian distributed model of the STFT into MFCC (log-Mel) and RASTA-PLP, deriving first and second order moments \[[Book Chapter](https://pdfs.semanticscholar.org/d32d/72e4dcc59bd014fb9f6428824df035fecaf4.pdf)\].

- Exploiting this fact to derive extensions of super-Gausian prior MMSE estimators based on mixture models \[[IEEE SPL article](http://ieeexplore.ieee.org/abstract/document/5504821/)\].

- Showing that this can improve the robustness of ASR systems without retraining, including for performant methods such as the ETSI advanced front-end \[[IEEE STSP article](http://ieeexplore.ieee.org/abstract/document/5504821/)\].

Aside from my PhD, in my time in Berlin I also got to tutor the Neural Networks Seminar of EMSP, supervised Phillip Mandelartz's Thesis and helped other students in the department with their projects and theses.

After defending my thesis I still spent some months at EMSP finishing papers. While finishing, a causality led me to discover Isabel Trancoso's department at INESC-ID in Lisbon. After reading João Graças and Diamantino Caseiros papers, I decided to apply for a post-doctoral grant to transition from speech to natural language processing. Luckily, I was awarded with a 3+3 year FCT Post-Doctoral grant to join INESC-ID/L2F. 

### 2006
I worked as an intern at Peiker Acustic for six months with the aid of a Leonardo grant and in collaboration with the TU-Berlin. The output was a spectral codebook-based speech reconstruction algorithm. Aside from realising how hard is to write a tech report in German, I also got to know better the Minimum Mean Spectral Amplitude and Log Spectral Amplitude Estimators (also known and Ephraim-Malah filters). 

On this same year I was awarded with a _La Caixa_ and the German Academic Exchange Service (DAAD) scholarship for research towards the Ph.D. degree at the EMSP department of the Technische Universität Berlin. I started working with Dorothea Kolossa on the topic of uncertainty propagation.

### 2005
I got the Industrial Engineering degree with specialization in electronics and automatics at the Escuela Politecnica Superior de Ingenieria de Gijon (Spain). At the time, this was a 6 year multidisciplinary degree plus thesis. I got to learn a lot of math/phisics and all things engineering from industrial heat and cold to macro-economy, got also to play with all levels of programming languages from VHDL and x86 CISC to Visual C++ and MFCs (no Python sadly). On my free time, I started learning fuzzy logic and programmed my first neural network.

I did my last year at Technische Universität Berlin with the aid of an Erasmus grant (2004). My final thesis was also at TU-Berlin, at the Electronics and Medical Signal Processing (EMSP) department (2005). My thesis was directed by Dorothea Kolossa and the topic was prunning in tied-mixture Hidden Markov Models for Automatic Speech Recognition.
